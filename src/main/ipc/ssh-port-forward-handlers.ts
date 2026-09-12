import { ipcMain } from 'electron'
import {
  enrichSshForwardEntries,
  getWorktreeIdsForConnection
} from '../ports/ssh-advertised-url-enrichment'
import { activeSessions } from './ssh-active-relay-sessions'
import {
  connectionManager,
  getCurrentMainWindow,
  persistedStore,
  portForwardManager
} from './ssh-ipc-context'
import { persistPortForwards } from './ssh-port-forward-persistence'
import { broadcastPortForwards, enrichDetected } from './ssh-renderer-broadcast'
import { assertSshResetAdmissionAllowed } from './ssh-reset-production-state'

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
    ) => {
      assertSshResetAdmissionAllowed(args.targetId)
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
      assertSshResetAdmissionAllowed(args.targetId)
      persistPortForwards(args.targetId)
      broadcastPortForwards(getCurrentMainWindow, args.targetId)
      return entry
    }
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
    ) => {
      const existing = portForwardManager!.listForwards().find((entry) => entry.id === args.id)
      if (!existing) {
        throw new Error(`Port forward "${args.id}" not found`)
      }
      assertSshResetAdmissionAllowed(existing.connectionId)
      if (existing.connectionId !== args.targetId) {
        throw new Error('SSH port forward target mismatch')
      }
      const conn = connectionManager!.getConnection(args.targetId)
      if (!conn) {
        throw new Error(`SSH connection "${args.targetId}" not found`)
      }
      try {
        const entry = await portForwardManager!.updateForward(
          args.id,
          conn,
          args.localPort,
          args.remoteHost,
          args.remotePort,
          args.label
        )
        assertSshResetAdmissionAllowed(entry.connectionId)
        persistPortForwards(entry.connectionId)
        broadcastPortForwards(getCurrentMainWindow, entry.connectionId)
        return entry
      } catch (err) {
        assertSshResetAdmissionAllowed(existing.connectionId)
        // Why: edit/rollback may have failed, so resync renderer to actual runtime state.
        persistPortForwards(args.targetId)
        broadcastPortForwards(getCurrentMainWindow, args.targetId)
        throw err
      }
    }
  )

  ipcMain.handle('ssh:removePortForward', async (_event, args: { id: string }) => {
    const existing = portForwardManager!.listForwards().find((entry) => entry.id === args.id)
    if (!existing) {
      return null
    }
    assertSshResetAdmissionAllowed(existing.connectionId)
    const removed = await portForwardManager!.removeForwardAndWait(args.id)
    if (removed) {
      assertSshResetAdmissionAllowed(removed.connectionId)
      persistPortForwards(removed.connectionId)
      broadcastPortForwards(getCurrentMainWindow, removed.connectionId)
    }
    return removed
  })

  ipcMain.handle('ssh:listPortForwards', (_event, args?: { targetId?: string }) => {
    const all = portForwardManager!.listForwards(args?.targetId)
    if (!persistedStore || !args?.targetId) {
      // Why: cross-target entries can't be mapped to worktrees in one call, so serve the raw list.
      return all
    }
    return enrichSshForwardEntries(all, getWorktreeIdsForConnection(persistedStore, args.targetId))
  })

  ipcMain.handle('ssh:listDetectedPorts', (_event, args: { targetId: string }) => {
    const session = activeSessions.get(args.targetId)
    const ports = session?.getPortScanner()?.getDetectedPorts(args.targetId) ?? []
    return enrichDetected(args.targetId, ports)
  })
}
