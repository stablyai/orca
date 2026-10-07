import { randomUUID } from 'node:crypto'
import type { IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { getPtyIpc } from '../../pty-host-bindings'
import { TerminalModelCheckpointLeases } from '../../../runtime/terminal-model-checkpoint-leases'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { PtyRendererDelivery } from '../session'
import { isMainWindowPtyIpcEvent } from './renderer-ipc-authority'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'

const terminalId = z.string().min(1).max(512)
const captureParams = z.object({ id: terminalId, expectedIncarnationId: terminalId }).strict()
const releaseParams = z.object({ id: terminalId, leaseId: z.string().uuid() }).strict()
const readParams = releaseParams.extend({
  resourceId: z.number().int().positive().nullable(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive()
})
let disposeInstalled: (() => void) | null = null

export function installPtyModelCheckpointIpc(deps: {
  runtime?: OrcaRuntimeService
  mainWindow?: PtyRendererDelivery
}): void {
  disposeInstalled?.()
  const ipc = getPtyIpc()
  const channels = [
    'pty:captureModelCheckpoint',
    'pty:readModelCheckpoint',
    'pty:releaseModelCheckpoint'
  ]
  for (const channel of channels) {
    ipc.removeHandler(channel)
  }
  const { runtime, mainWindow } = deps
  const contents = mainWindow?.webContents
  const leases = new TerminalModelCheckpointLeases()
  let viewerId = randomUUID()
  const rotateViewer = (): void => {
    leases.releaseViewer(viewerId)
    viewerId = randomUUID()
  }
  const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
    if (details.isMainFrame && !details.isSameDocument) {
      rotateViewer()
    }
  }
  const dispose = (): void => {
    leases.dispose()
    contents?.removeListener('did-start-navigation', onNavigation)
    contents?.removeListener('did-finish-load', rotateViewer)
    contents?.removeListener('render-process-gone', rotateViewer)
    contents?.removeListener('destroyed', dispose)
  }
  contents?.on('did-start-navigation', onNavigation)
  contents?.on('did-finish-load', rotateViewer)
  contents?.on('render-process-gone', rotateViewer)
  contents?.on('destroyed', dispose)
  disposeInstalled = dispose
  const authorized = (event: IpcMainInvokeEvent): boolean =>
    isMainWindowPtyIpcEvent(event, mainWindow) &&
    !!event.senderFrame &&
    event.senderFrame === event.sender.mainFrame

  ipc.handle('pty:captureModelCheckpoint', async (event, request: unknown) => {
    const params = captureParams.safeParse(request)
    if (
      !runtime ||
      !authorized(event) ||
      !params.success ||
      ptyOwnership.get(params.data.id) !== null ||
      ptyIncarnationById.get(params.data.id) !== params.data.expectedIncarnationId
    ) {
      return null
    }
    const owner = {
      viewerId,
      ptyId: params.data.id,
      incarnationId: params.data.expectedIncarnationId
    }
    let unsubscribe: (() => void) | undefined
    try {
      const descriptor = await leases.capture(
        owner,
        async (budget) => {
          unsubscribe = runtime.subscribeToPtyExit(owner.ptyId, () =>
            leases.releasePty(owner.ptyId)
          )
          return runtime.captureHeadlessTerminalModelCheckpoint(
            owner.ptyId,
            budget,
            owner.incarnationId
          )
        },
        () => unsubscribe?.()
      )
      if (
        descriptor &&
        (ptyOwnership.get(owner.ptyId) !== null ||
          ptyIncarnationById.get(owner.ptyId) !== owner.incarnationId)
      ) {
        leases.release(owner, descriptor.leaseId)
        return null
      }
      return descriptor
    } catch {
      return null
    }
  })
  ipc.handle('pty:readModelCheckpoint', (event, request: unknown) => {
    const params = readParams.safeParse(request)
    if (!authorized(event) || !params.success || ptyOwnership.get(params.data.id) !== null) {
      throw new Error('Invalid or expired terminal checkpoint lease')
    }
    return leases.read(
      { viewerId, ptyId: params.data.id, incarnationId: ptyIncarnationById.get(params.data.id) },
      params.data
    )
  })
  ipc.handle('pty:releaseModelCheckpoint', (event, request: unknown) => {
    const params = releaseParams.safeParse(request)
    if (!authorized(event) || !params.success) {
      return false
    }
    return leases.release(
      { viewerId, ptyId: params.data.id, incarnationId: ptyIncarnationById.get(params.data.id) },
      params.data.leaseId
    )
  })
}
