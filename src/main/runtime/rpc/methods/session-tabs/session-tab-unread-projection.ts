import type {
  AgentListPublication,
  AgentListVerdict
} from '../../../../../shared/agent-status/presentation/agent-list-status'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { sessionTabPaneKey } from '../../../../../shared/remote-runtime/session-graph/session-tab-pane-key'

type Verdicts = Readonly<Record<string, AgentListVerdict>> | undefined

function isUnread(
  verdicts: Verdicts,
  tab: RuntimeMobileSessionTabsResult['tabs'][number]
): boolean {
  const paneKey = verdicts && sessionTabPaneKey(tab)
  const verdict = paneKey ? verdicts[paneKey] : undefined
  return verdict?.listed === true && verdict.unread
}

function projectSessionTabUnread(
  snapshot: RuntimeMobileSessionTabsResult,
  verdicts: Verdicts
): RuntimeMobileSessionTabsResult {
  if (!verdicts || !snapshot.tabs.some((tab) => isUnread(verdicts, tab))) {
    return snapshot
  }
  return {
    ...snapshot,
    tabs: snapshot.tabs.map((tab) => (isUnread(verdicts, tab) ? { ...tab, unread: true } : tab))
  }
}

/** Phones mark each tab whose agent the desktop Agents list holds unread; with no window's verdicts, none. */
export function projectSessionTabUnreadForClient(
  runtime: { readAgentListPublication?: () => AgentListPublication | null },
  snapshot: RuntimeMobileSessionTabsResult,
  clientKind: 'mobile' | 'runtime' | undefined
): RuntimeMobileSessionTabsResult {
  return clientKind === 'mobile'
    ? projectSessionTabUnread(snapshot, runtime.readAgentListPublication?.()?.verdicts)
    : snapshot
}

/** The tabs a phone's frame marks unread, read straight from the verdicts so an unchanged set costs no projection. */
export function sessionTabUnreadMarks(
  runtime: { readAgentListPublication?: () => AgentListPublication | null },
  snapshot: RuntimeMobileSessionTabsResult,
  clientKind: 'mobile' | 'runtime' | undefined
): string {
  const verdicts =
    clientKind === 'mobile' ? runtime.readAgentListPublication?.()?.verdicts : undefined
  return verdicts
    ? snapshot.tabs
        .filter((tab) => isUnread(verdicts, tab))
        .map((tab) => tab.id)
        .join('\n')
    : ''
}
