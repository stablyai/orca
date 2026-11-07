import type { PtyRendererDelivery } from '../session'
import { getPtyIpc } from '../pty-host-bindings'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { createPtyWriteInput, type PtyWritePayload } from './write-input'
import { followLocalGeneratedInputWrite } from '../../../runtime/generated-agent-input-notices-ingress'

export function installPtyWriteIpcHandlers(deps: {
  mainWindow?: PtyRendererDelivery
  runtime?: OrcaRuntimeService
}): void {
  const ipcMain = getPtyIpc()
  const { runtime } = deps
  const {
    writePtyInput,
    writePtyInputAccepted,
    isPtyWritePayload,
    isPtyViewportClaimPayload,
    isPtyWriteEventFromMainWindow
  } = createPtyWriteInput(deps)

  const hostViewportClaimTails = new Map<string, Promise<boolean>>()
  // A write of a window's accepted generated request settles that request where it happens, even
  // when the window that asked is gone.
  const followed = (
    sender: { id: number },
    args: PtyWritePayload,
    write: (payload: PtyWritePayload) => boolean | Promise<boolean>
  ): boolean | Promise<boolean> => {
    const follow =
      runtime && args.generatedInputOperationId
        ? followLocalGeneratedInputWrite(
            runtime.generatedInputNotices,
            args.generatedInputOperationId,
            `desktop-window:${sender.id}`
          )
        : null
    if (!follow) {
      return write(args)
    }
    const settle = (accepted: boolean): boolean => {
      follow.settled(accepted ? 'accepted' : 'refused')
      return accepted
    }
    // Written at once, in the same order as any other write.
    let result: boolean | Promise<boolean>
    try {
      result = write({ ...args, onProviderHandoff: follow.handedOff })
    } catch (error) {
      follow.settled('unknown')
      throw error
    }
    return typeof result === 'boolean'
      ? settle(result)
      : result.then(settle, (error: unknown) => {
          follow.settled('unknown')
          throw error
        })
  }

  ipcMain.on('pty:write', (event, args: unknown) => {
    if (!isPtyWriteEventFromMainWindow(event) || !isPtyWritePayload(args)) {
      return
    }
    const claimTail = hostViewportClaimTails.get(args.id)
    const write = (payload: PtyWritePayload) =>
      claimTail
        ? claimTail.then((claimed) => (claimed ? writePtyInput(payload) : false))
        : writePtyInput(payload)
    void Promise.resolve(followed(event.sender, args, write)).catch(() => {})
  })
  ipcMain.handle('pty:writeAccepted', (event, args: unknown): boolean | Promise<boolean> => {
    if (!isPtyWriteEventFromMainWindow(event) || !isPtyWritePayload(args)) {
      return false
    }
    const claimTail = hostViewportClaimTails.get(args.id)
    return followed(event.sender, args, (payload) =>
      claimTail
        ? claimTail.then((claimed) => (claimed ? writePtyInputAccepted(payload) : false))
        : writePtyInputAccepted(payload)
    )
  })

  ipcMain.removeAllListeners('pty:claimViewport')
  ipcMain.on('pty:claimViewport', (event, args: unknown) => {
    if (!isPtyWriteEventFromMainWindow(event) || !runtime || !isPtyViewportClaimPayload(args)) {
      return
    }
    const prior = hostViewportClaimTails.get(args.id)
    // A second mirrored pane must join the in-flight resize claim before input, never replace it with a no-op.
    const claim = (
      prior
        ? prior.then(
            () => runtime.claimRemoteDesktopHost(args.id, args.cols, args.rows),
            () => runtime.claimRemoteDesktopHost(args.id, args.cols, args.rows)
          )
        : runtime.claimRemoteDesktopHost(args.id, args.cols, args.rows)
    ).catch((error) => {
      // Claim failure drops gated input; surface it instead of failing silently.
      console.error('[pty] remote desktop host claim failed; gated input will be discarded', error)
      return false
    })
    hostViewportClaimTails.set(args.id, claim)
    void claim.then(() => {
      if (hostViewportClaimTails.get(args.id) === claim) {
        hostViewportClaimTails.delete(args.id)
      }
    })
  })
}
