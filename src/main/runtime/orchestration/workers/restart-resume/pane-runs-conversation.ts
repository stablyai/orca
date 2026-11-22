import type { OrcaRuntimeService } from '../../../orca-runtime'

type PaneRows = Pick<OrcaRuntimeService, 'getAgentStatusRowsForPane'>

/** The conversations this pane's live agent reported: never a launch-only or restored-from-disk row,
 *  which outlive the process that wrote them. */
export function paneLiveSessions(runtime: PaneRows, paneKey: string): string[] {
  return runtime
    .getAgentStatusRowsForPane(paneKey)
    .flatMap((row) =>
      row.providerSession?.id && !row.providerSessionOnly && !row.restoredUnconfirmed
        ? [row.providerSession.id]
        : []
    )
}

/** What this pane's live agent runs, as far as its hooks have said: `own` is this conversation,
 *  `other` another one, `unknown` no live turn yet. */
export function paneConversation(
  runtime: PaneRows,
  paneKey: string,
  sessionId: string
): 'own' | 'other' | 'unknown' {
  const sessions = paneLiveSessions(runtime, paneKey)
  return sessions.includes(sessionId) ? 'own' : sessions.length > 0 ? 'other' : 'unknown'
}
