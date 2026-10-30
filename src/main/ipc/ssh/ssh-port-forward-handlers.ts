import { ipcMain } from 'electron'
import {
  enrichSshForwardEntries,
  getWorktreeIdsForConnection
} from '../../ports/ssh-advertised-url-enrichment'
import {
  connectionManager,
  getCurrentMainWindow,
  persistedStore,
  portForwardManager
} from './ssh-ipc-context'
import { persistPortForwards } from './ssh-port-forward-persistence'
import { serializePortForwardChange } from './ssh-managed-port-forward-restore'
import { clearForwardFailure, listUnrestoredPortForwards } from './ssh-port-forward-unrestored'
import { PortForwardTornDownError } from '../../ssh/port-forwarding/ssh-port-forward'
import { broadcastPortForwards, enrichDetected } from './ssh-renderer-broadcast'

export function registerSshPortForwardHandlers(): void {
  ipcMain.handle(
    'ssh:addPortForward',
    async (
      _event,
      args: {
        targetId: string
        localPort: number
        remoteHost: string
        remotePort: number
        label?: string
      }
    ) =>
      serializePortForwardChange(args.targetId, async () => {
        const conn = connectionManager!.getConnection(args.targetId)
        if (!conn) {
          throw new Error(`SSH connection "${args.targetId}" not found`)
        }
        const entry = await portForwardManager!.addForward(
          args.targetId,
          conn,
          args.localPort,
          args.remoteHost,
          args.remotePort,
          args.label
        )
        // A forward the user adds again starts a fresh backoff.
        clearForwardFailure(args.targetId, entry)
        persistPortForwards(args.targetId)
        broadcastPortForwards(getCurrentMainWindow, args.targetId)
        return entry
      })
  )

  ipcMain.handle(
    'ssh:updatePortForward',
    async (
      _event,
      args: {
        id: string
        targetId: string
        localPort: number
        remoteHost: string
        remotePort: number
        label?: string
      }
    ) =>
      serializePortForwardChange(args.targetId, async () => {
        const conn = connectionManager!.getConnection(args.targetId)
        if (!conn) {
          throw new Error(`SSH connection "${args.targetId}" not found`)
        }
        const previous = portForwardManager!
          .listForwards(args.targetId)
          .find((forward) => forward.id === args.id)
        try {
          const entry = await portForwardManager!.updateForward(
            args.id,
            conn,
            args.localPort,
            args.remoteHost,
            args.remotePort,
            args.label
          )
          clearForwardFailure(entry.connectionId, entry)
          if (previous) {
            clearForwardFailure(entry.connectionId, previous)
          }
          persistPortForwards(entry.connectionId, previous)
          broadcastPortForwards(getCurrentMainWindow, entry.connectionId)
          return entry
        } catch (err) {
          // Disconnect clears runtime forwards; persisting that empty list would erase saved configuration.
          if (!(err instanceof PortForwardTornDownError)) {
            persistPortForwards(args.targetId)
          }
          // Edit or rollback may fail; resync the renderer with actual forwarding state.
          broadcastPortForwards(getCurrentMainWindow, args.targetId)
          throw err
        }
      })
  )

  ipcMain.handle('ssh:removePortForward', async (_event, args: { id: string }) => {
    const targetId = portForwardManager!
      .listForwards()
      .find((forward) => forward.id === args.id)?.connectionId
    if (!targetId) {
      return null
    }
    return serializePortForwardChange(targetId, async () => {
      // An edit queued ahead may have replaced this entry, or moved it to another host.
      const current = portForwardManager!
        .listForwards(targetId)
        .find((forward) => forward.id === args.id)
      if (!current) {
        return null
      }
      const removed = await portForwardManager!.removeForwardAndWait(args.id)
      if (removed) {
        clearForwardFailure(removed.connectionId, removed)
        persistPortForwards(removed.connectionId, removed)
        broadcastPortForwards(getCurrentMainWindow, removed.connectionId)
      }
      return removed
    })
  })

  ipcMain.handle('ssh:listUnrestoredPortForwards', (_event, args: { targetId: string }) =>
    listUnrestoredPortForwards(args.targetId)
  )

  // A saved forward that never started has no live id, so it is removed by its mapping.
  ipcMain.handle(
    'ssh:removeSavedPortForward',
    (
      _event,
      args: { targetId: string; localPort: number; remoteHost: string; remotePort: number }
    ) =>
      serializePortForwardChange(args.targetId, async () => {
        const { targetId, ...mapping } = args
        // A restore queued ahead may have opened it since the row was drawn; close that too.
        const live = portForwardManager!
          .listForwards(targetId)
          .find(
            (forward) =>
              forward.localPort === mapping.localPort &&
              forward.remoteHost === mapping.remoteHost &&
              forward.remotePort === mapping.remotePort
          )
        if (live) {
          await portForwardManager!.removeForwardAndWait(live.id)
        }
        persistPortForwards(targetId, mapping)
        clearForwardFailure(targetId, mapping)
        broadcastPortForwards(getCurrentMainWindow, targetId)
      })
  )

  ipcMain.handle('ssh:listPortForwards', (_event, args?: { targetId?: string }) => {
    const all = portForwardManager!.listForwards(args?.targetId)
    if (!persistedStore || !args?.targetId) {
      // Cross-target rows cannot be attributed to worktrees in one enrichment call.
      return all
    }
    return enrichSshForwardEntries(all, getWorktreeIdsForConnection(persistedStore, args.targetId))
  })

  ipcMain.handle('ssh:listDetectedPorts', (_event, args: { targetId: string }) => {
    // Detected ports came from the relay's port scanner; a managed host reports them through its runtime.
    return enrichDetected(args.targetId, [])
  })
}
