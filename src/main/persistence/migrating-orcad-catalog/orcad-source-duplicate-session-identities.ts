import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { visitOrcadMigrationSessionEntities } from './orcad-destination-workspace-session'
import { worktreeLabel } from './orcad-source-workspace-session-eligibility'

const KIND_LABELS: Record<string, string> = {
  terminal: 'one terminal tab saved twice',
  browser: 'one browser tab saved twice',
  'client-browser-page': 'one browser page saved twice',
  tab: 'one tab saved twice',
  group: 'one tab group saved twice'
}

const CLEAR = 'close one of them'

/** Name duplicate tabs locally so refusal explains identities the server would reject (#30610). */
export function collectDuplicateOrcadMigrationSessionIdentities(
  session: WorkspaceSessionState
): string[] {
  const owners = new Map<string, string[]>()
  visitOrcadMigrationSessionEntities(session, (key, owner) => {
    owners.set(key, [...(owners.get(key) ?? []), owner])
  })
  const terminalTabs = new Map(
    Object.entries(session.tabsByWorktree ?? {}).flatMap(([worktreeId, tabs]) =>
      tabs.map((tab) => [tab.id, { worktreeId, title: tab.customTitle ?? tab.title }] as const)
    )
  )
  const items: string[] = []
  for (const [key, keyOwners] of owners) {
    if (keyOwners.length < 2) {
      continue
    }
    const kind = key.slice(0, key.indexOf(':'))
    if (kind !== 'terminal-leaf') {
      const where = [...new Set(keyOwners)].map(worktreeLabel).join(' and ')
      items.push(`${KIND_LABELS[kind] ?? 'one saved item saved twice'} in ${where}: ${CLEAR}`)
      continue
    }
    const tabIds = [...new Set(keyOwners)]
    const tabs = tabIds.map((tabId) => terminalTabs.get(tabId))
    const worktrees = [...new Set(tabs.flatMap((tab) => (tab ? [tab.worktreeId] : [])))]
    const where = worktrees.length > 0 ? ` in ${worktrees.map(worktreeLabel).join(' and ')}` : ''
    const names = tabIds.map((tabId, index) => `"${tabs[index]?.title ?? tabId}"`)
    items.push(
      tabIds.length === 1
        ? `one terminal pane saved twice in the tab ${names[0]}${where}: close that tab`
        : `one terminal pane saved in ${tabIds.length === 2 ? 'two' : tabIds.length} tabs, ${names.join(' and ')},${where}: ${CLEAR}`
    )
  }
  return items
}
