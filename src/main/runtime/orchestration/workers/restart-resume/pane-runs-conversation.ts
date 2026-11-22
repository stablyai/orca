import type { OrcaRuntimeService } from '../../../orca-runtime'

/** What this pane's live agent runs, as far as its hooks have said: `own` is this conversation,
 *  `other` another one, `unknown` no live turn yet (a launch-only or restored-from-disk row). */
export function paneConversation(
  runtime: Pick<OrcaRuntimeService, 'getAgentStatusRowsForPane'>,
  paneKey: string,
  sessionId: string
): 'own' | 'other' | 'unknown' {
  let conversation: 'other' | 'unknown' = 'unknown'
  for (const row of runtime.getAgentStatusRowsForPane(paneKey)) {
    const id = row.providerSession?.id
    if (!id || row.providerSessionOnly || row.restoredUnconfirmed) {
      continue
    }
    if (id === sessionId) {
      return 'own'
    }
    conversation = 'other'
  }
  return conversation
}
