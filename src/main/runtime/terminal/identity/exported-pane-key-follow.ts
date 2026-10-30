import { agentHookServer } from '../../../agent-hooks/server'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

type ExportedPaneKeyPty = Pick<RuntimePtyWorktreeRecord, 'ptyId' | 'connected' | 'spawnPaneKey'>

/**
 * A live terminal shown in a pane other than the one its env exported (a restart re-homed it into
 * a new tab) keeps posting hooks under the exported key, so that key's agent status follows it.
 * Run over every record at once: when another live terminal also exported or shows either key, or
 * the terminal is back in its exported pane, the status returns under the exported key.
 */
export function followExportedPaneKeys<T extends ExportedPaneKeyPty>(
  records: Iterable<T>,
  paneKeyOf: (pty: T) => string | null
): void {
  const live = Array.from(records).flatMap((pty) =>
    pty.connected
      ? [{ ptyId: pty.ptyId, spawnPaneKey: pty.spawnPaneKey, paneKey: paneKeyOf(pty) }]
      : []
  )
  const claimants = new Map<string, number>()
  for (const pty of live) {
    for (const paneKey of new Set([pty.spawnPaneKey, pty.paneKey])) {
      if (paneKey) {
        claimants.set(paneKey, (claimants.get(paneKey) ?? 0) + 1)
      }
    }
  }
  for (const { ptyId, spawnPaneKey, paneKey } of live) {
    if (!spawnPaneKey || !paneKey) {
      continue
    }
    const follows =
      paneKey !== spawnPaneKey && claimants.get(spawnPaneKey) === 1 && claimants.get(paneKey) === 1
    if (!follows) {
      agentHookServer.returnPaneAuthority(spawnPaneKey, ptyId)
    } else if (agentHookServer.resolvePaneAuthorityOwner(spawnPaneKey) !== paneKey) {
      agentHookServer.transferPaneAuthority(spawnPaneKey, paneKey, ptyId, Date.now(), {
        authorityVerified: true
      })
    }
  }
}
