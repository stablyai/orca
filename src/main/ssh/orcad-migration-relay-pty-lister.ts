/**
 * The terminal gate's question to the relay: which PTYs does it still run for this target?
 *
 * Asked through the SSH PTY provider's `pty.listProcesses`, which the pinned relay answers the
 * same way on Windows and POSIX hosts, so a Windows relay-hosted target proves its terminals
 * exited exactly as a Linux one does. Ids come back in the relay's own spelling, which is how
 * the target's PTY leases name them.
 */
import { getSshPtyProvider } from '../ipc/pty/provider/registry'
import type { IPtyProvider } from '../providers/types'
import { toRelaySshPtyId } from '../providers/ssh-pty-id'
import type { ListRelayPtyIds } from './orcad-migration-terminal-gate'

/** Long enough for a Windows relay's first process-table read, short enough to block a click. */
export const ORCAD_MIGRATION_RELAY_LIST_BUDGET_MS = 10_000

/** Null when no relay session is connected: the gate then cannot clear expired leases. */
export function orcadMigrationRelayPtyLister(
  targetId: string,
  provider: Pick<IPtyProvider, 'listProcesses'> | undefined = getSshPtyProvider(targetId),
  now: () => number = Date.now
): ListRelayPtyIds | null {
  if (!provider) {
    return null
  }
  return async () => {
    const processes = await provider.listProcesses({
      deadlineMs: now() + ORCAD_MIGRATION_RELAY_LIST_BUDGET_MS
    })
    return processes.map((process) => toRelaySshPtyId(targetId, process.id))
  }
}
