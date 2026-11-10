import type { DaemonClient } from '../../transport/client/daemon-client'
import type { HistoryManager } from '../../history/storage/history-manager'
import type { CheckpointSessionQueue } from '../checkpointing/daemon-checkpoint-session-queue'
import type { TerminalHistorySessionWriter } from '../../history/storage/terminal-history-session-writer'
import type { ListSessionsResult } from '../../protocol/daemon-rpc-contract'
import { sameEndpointIdentity } from '../../endpoint/identity/daemon-endpoint-incarnation'

export function registerDaemonHistoryIdentity(
  manager: HistoryManager | null,
  queue: CheckpointSessionQueue,
  client: DaemonClient,
  protocolVersion: number
): {
  release: (
    disposition: 'clean' | 'detach',
    retainedWriters?: ReadonlySet<TerminalHistorySessionWriter>
  ) => Promise<void>
  retire: () => void
} {
  const root = manager?.identityRoot
  if (!root) {
    return {
      retire: () => {},
      release: async (disposition, retainedWriters) => {
        await queue.drain()
        await manager?.releaseIdentity(disposition, retainedWriters)
      }
    }
  }
  const unregisterHost = root.registerHost({
    protocolVersion: protocolVersion,
    reservations: async () => {
      await client.ensureConnectedWithin(1_000)
      const before = client.getDaemonIdentity()
      const response = await client.request<ListSessionsResult>(
        'listSessions',
        { includeReservations: true },
        1_000
      )
      const after = client.getDaemonIdentity()
      return before && after && sameEndpointIdentity(before, after) ? response.reservations : null
    }
  })
  let retired = false
  const retire = () => {
    if (!retired) {
      retired = true
      unregisterHost()
    }
  }
  let release: Promise<void> | undefined
  return {
    retire,
    release: (disposition, retainedWriters) => {
      root.cancelMigrations()
      release ??= (async () => {
        await queue.drain()
        await manager?.releaseIdentity(disposition, retainedWriters)
        retire()
      })()
      return release
    }
  }
}
