import type Database from '../sqlite/sync-database'
import type { PersistedState } from '../../shared/persisted-state-types'
import type {
  SurfaceStorageCommand,
  SurfaceStorageResult
} from '../../shared/workspace-surfaces/surface-storage-command'
import { rekeyPaneProfileRecords } from '../persistence/terminal-topology/terminal-leaf-move'

type PaneProfileRecords = Partial<Pick<PersistedState, 'ui' | 'sshRemotePtyLeases'>>

export function rekeySurfacePaneProfileRecords(
  state: PaneProfileRecords,
  command: SurfaceStorageCommand,
  outcome: SurfaceStorageResult['outcome']
): Partial<PaneProfileRecords> {
  if (
    command.type !== 'layout' ||
    command.request.command.type !== 'movePaneToNewTab' ||
    !outcome ||
    typeof outcome !== 'object' ||
    !('result' in outcome) ||
    outcome.status !== 'accepted' ||
    !outcome.result.tabId
  ) {
    return {}
  }
  const move = command.request.command
  const row = command.session.unifiedTabs?.[move.workspace]?.find((tab) => tab.id === move.tabId)
  return rekeyPaneProfileRecords(
    state,
    { tabId: row?.contentType === 'terminal' ? row.entityId : move.tabId, leafId: move.leafId },
    { tabId: outcome.result.tabId, leafId: move.leafId }
  )
}

/** Pane identity and its profile records share the canonical transaction's commit point. */
export function surfacePaneProfileReplacements(
  db: Database.Database,
  commands: readonly SurfaceStorageCommand[],
  results: readonly { outcome: SurfaceStorageResult['outcome'] }[]
): { domain: string; payload: string }[] {
  if (
    !commands.some(
      (command) => command.type === 'layout' && command.request.command.type === 'movePaneToNewTab'
    )
  ) {
    return []
  }
  const state: PaneProfileRecords = { sshRemotePtyLeases: [] }
  for (const domain of ['ui', 'sshRemotePtyLeases'] as const) {
    const payload = db
      .prepare('SELECT payload FROM main.profile_state_documents WHERE domain = ?')
      .get(domain)?.payload
    if (typeof payload === 'string') {
      Object.assign(state, { [domain]: JSON.parse(payload) })
    }
  }
  const changed = new Set<keyof PaneProfileRecords>()
  for (const [index, command] of commands.entries()) {
    const rekeyed = rekeySurfacePaneProfileRecords(state, command, results[index]?.outcome ?? null)
    for (const key of Object.keys(rekeyed) as (keyof PaneProfileRecords)[]) {
      changed.add(key)
    }
    Object.assign(state, rekeyed)
  }
  return [...changed].map((domain) => ({ domain, payload: JSON.stringify(state[domain]) }))
}
