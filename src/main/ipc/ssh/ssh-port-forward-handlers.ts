import type { RegisterSshRequest } from '../../ssh/application/ssh-application-requests'
import {
  enrichSshForwardEntries,
  getWorktreeIdsForConnection
} from '../../ports/ssh-advertised-url-enrichment'
import { connectionManager, persistedStore, portForwardManager } from './ssh-ipc-context'
import { persistPortForwards } from './ssh-port-forward-persistence'
import { serializePortForwardChange } from './ssh-managed-port-forward-restore'
import { clearForwardFailure, listUnrestoredPortForwards } from './ssh-port-forward-unrestored'
import { PortForwardTornDownError } from '../../ssh/port-forwarding/ssh-port-forward'
import { assertIpv6LoopbackPortFree } from '../../ssh/port-forwarding/local-forward-ipv6-loopback-probe'
import { addForwardOnFreeLocalPort } from '../../ssh/port-forwarding/forward-local-port-choice'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { loopbackPortForwardDialHost } from '../../../shared/workspace/ports/port-forward-loopback-host'
import { broadcastPortForwards, enrichDetected } from './ssh-renderer-broadcast'

// Covers a fresh OpenSSH login through a jump host; past it the click reports a failure.
const FORWARD_LISTENER_TIMEOUT_MS = 20_000

export function registerSshPortForwardHandlers(handle: RegisterSshRequest): void {
  handle(
    'ssh:addPortForward',
    async (args: {
      targetId: string
      localPort: number
      remoteHost: string
      remotePort: number
      label?: string
    }) =>
      serializePortForwardChange(args.targetId, async () => {
        const conn = connectionManager!.getConnection(args.targetId)
        if (!conn) {
          throw new Error(`SSH connection "${args.targetId}" not found`)
        }
        await assertIpv6LoopbackPortFree(args.localPort)
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
        broadcastPortForwards(args.targetId)
        return entry
      })
  )

  // The renderer calls this only from a person's click on the host's localhost link or port.
  handle('ssh:ensurePortForward', (args: { targetId: string; remotePort: number }) => {
    const targetId = typeof args?.targetId === 'string' ? args.targetId : ''
    const remotePort = args?.remotePort
    if (!targetId || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
      throw new Error('Invalid port forward request')
    }
    return serializePortForwardChange(targetId, async () => {
      const existing = portForwardManager!
        .listForwards(targetId)
        .find(
          (forward) =>
            forward.remotePort === remotePort &&
            loopbackPortForwardDialHost(forward.remoteHost) !== null
        )
      if (existing) {
        return { entry: existing, created: false }
      }
      const conn = connectionManager!.getConnection(targetId)
      if (!conn) {
        throw new Error(`SSH connection "${targetId}" not found`)
      }
      const saved = getSshTargetRegistryStore()?.getTarget(targetId)?.portForwards ?? []
      const entry = await addForwardOnFreeLocalPort({
        remotePort,
        add: (localPort) =>
          portForwardManager!.addForward(targetId, conn, localPort, 'localhost', remotePort),
        remove: (id) => portForwardManager!.removeForwardAndWait(id),
        // SSH forwards listen on 127.0.0.1 only.
        holdsIpv6Loopback: false,
        // A saved forward that couldn't restore keeps its port; persisting a new one there would drop it.
        reservedLocalPorts: new Set(saved.map((forward) => forward.localPort)),
        // The caller opens the address next; a slow SSH login must not hand it a port nothing answers yet.
        listening: {
          timeoutMs: FORWARD_LISTENER_TIMEOUT_MS,
          isOpen: (entry) =>
            portForwardManager!.listForwards(targetId).some((forward) => forward.id === entry.id)
        }
      })
      clearForwardFailure(targetId, entry)
      persistPortForwards(targetId)
      broadcastPortForwards(targetId)
      return { entry, created: true }
    })
  })

  handle(
    'ssh:updatePortForward',
    async (args: {
      id: string
      targetId: string
      localPort: number
      remoteHost: string
      remotePort: number
      label?: string
    }) =>
      serializePortForwardChange(args.targetId, async () => {
        const conn = connectionManager!.getConnection(args.targetId)
        if (!conn) {
          throw new Error(`SSH connection "${args.targetId}" not found`)
        }
        const previous = portForwardManager!
          .listForwards(args.targetId)
          .find((forward) => forward.id === args.id)
        // The forward being edited listens on 127.0.0.1 only, so it never answers this probe.
        await assertIpv6LoopbackPortFree(args.localPort)
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
          broadcastPortForwards(entry.connectionId)
          return entry
        } catch (err) {
          // Disconnect clears runtime forwards; persisting that empty list would erase saved configuration.
          if (!(err instanceof PortForwardTornDownError)) {
            persistPortForwards(args.targetId)
          }
          // Edit or rollback may fail; resync the renderer with actual forwarding state.
          broadcastPortForwards(args.targetId)
          throw err
        }
      })
  )

  handle('ssh:removePortForward', async (args: { id: string }) => {
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
        broadcastPortForwards(removed.connectionId)
      }
      return removed
    })
  })

  handle('ssh:listUnrestoredPortForwards', (args: { targetId: string }) =>
    listUnrestoredPortForwards(args.targetId)
  )

  // A saved forward that never started has no live id, so it is removed by its mapping.
  handle(
    'ssh:removeSavedPortForward',
    (args: { targetId: string; localPort: number; remoteHost: string; remotePort: number }) =>
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
        broadcastPortForwards(targetId)
      })
  )

  handle('ssh:listPortForwards', (args?: { targetId?: string }) => {
    const all = portForwardManager!.listForwards(args?.targetId)
    if (!persistedStore || !args?.targetId) {
      // Cross-target rows cannot be attributed to worktrees in one enrichment call.
      return all
    }
    return enrichSshForwardEntries(all, getWorktreeIdsForConnection(persistedStore, args.targetId))
  })

  handle('ssh:listDetectedPorts', (args: { targetId: string }) => {
    // Detected ports came from the relay's port scanner; a managed host reports them through its runtime.
    return enrichDetected(args.targetId, [])
  })
}
