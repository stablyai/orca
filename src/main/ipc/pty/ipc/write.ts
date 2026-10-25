import type { PtyRendererDelivery, PtyIpcSessionOptions } from '../session'
import { getPtyIpc } from '../../pty-host-bindings'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { createPtyWriteInput } from './write-input'

export function installPtyWriteIpcHandlers(deps: {
  mainWindow?: PtyRendererDelivery
  runtime?: OrcaRuntimeService
  nativeWindowDelivery?: PtyIpcSessionOptions['nativeWindowDelivery']
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

  ipcMain.on('pty:write', (event, args: unknown) => {
    if (!isPtyWriteEventFromMainWindow(event) || !isPtyWritePayload(args)) {
      return
    }
    if (
      args.inputKind === 'query-reply' &&
      deps.nativeWindowDelivery &&
      !deps.nativeWindowDelivery.canReply(event.sender, args.id)
    ) {
      return
    }
    if (args.inputKind === 'driving') {
      deps.nativeWindowDelivery?.claim(event.sender, args.id)
    }
    const claimTail = hostViewportClaimTails.get(args.id)
    if (claimTail) {
      void claimTail.then((claimed) => (claimed ? writePtyInput(args) : false))
      return
    }
    writePtyInput(args)
  })
  ipcMain.handle('pty:writeAccepted', (event, args: unknown): boolean | Promise<boolean> => {
    if (!isPtyWriteEventFromMainWindow(event) || !isPtyWritePayload(args)) {
      return false
    }
    if (
      args.inputKind === 'query-reply' &&
      deps.nativeWindowDelivery &&
      !deps.nativeWindowDelivery.canReply(event.sender, args.id)
    ) {
      return false
    }
    if (args.inputKind === 'driving') {
      deps.nativeWindowDelivery?.claim(event.sender, args.id)
    }
    const claimTail = hostViewportClaimTails.get(args.id)
    return claimTail
      ? claimTail.then((claimed) => (claimed ? writePtyInputAccepted(args) : false))
      : writePtyInputAccepted(args)
  })

  ipcMain.removeAllListeners('pty:claimViewport')
  ipcMain.on('pty:claimViewport', (event, args: unknown) => {
    if (!isPtyWriteEventFromMainWindow(event) || !runtime || !isPtyViewportClaimPayload(args)) {
      return
    }
    deps.nativeWindowDelivery?.claim(event.sender, args.id)
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
