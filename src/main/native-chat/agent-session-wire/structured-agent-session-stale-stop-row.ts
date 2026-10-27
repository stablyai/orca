// Key notices by matching death/replacement proof so settlement retries cannot duplicate them.

import { STALE_SESSION_ROW_PREFIX } from '../../../shared/agent-session-stop-row-identity'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalRenderItem,
  AgentJournalStatusItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionReplacedRuntime } from '../../runtime/agent-session/agent-session-replaced-runtime'
import { orcaStopRowBody } from './structured-agent-session-orca-stop-row'

export type StaleCut = { by: 'death' } | { by: 'replaced'; fence: number } | null

export function isUnverifiableTurn(item: AgentJournalRenderItem): boolean {
  return readAgentJournalTurn(item.body)?.state === 'unverifiable'
}

export function staleStopRow(
  input: {
    sessionId: string
    deathEvidence: AgentSessionDeathEvidence | null
    replaced?: AgentSessionReplacedRuntime
    failureTextContext?: AgentSessionFailureWordsContext
  },
  items: readonly AgentJournalRenderItem[],
  cutBy: (item: AgentJournalRenderItem) => StaleCut
): {
  kind: 'item'
  identity: { provider: 'orca'; clientMessageId: string }
  body: AgentJournalStatusItem
} | null {
  const cuts = items.map(cutBy)
  const evidence = input.deathEvidence
  // Death diagnostics stay in logs; show only provider stop and associated Orca shutdown cause.
  if (evidence && cuts.some((cut) => cut?.by === 'death')) {
    return {
      kind: 'item',
      identity: {
        provider: 'orca',
        clientMessageId: `${STALE_SESSION_ROW_PREFIX}${input.sessionId}:death-${evidence.ownerFence ?? 'unowned'}-${evidence.observedAt}`
      },
      body: orcaStopRowBody(input.failureTextContext, evidence.runtimeEnd)
    }
  }
  const fences = cuts.flatMap((cut) => (cut?.by === 'replaced' ? [cut.fence] : []))
  if (!input.replaced || fences.length === 0) {
    return null
  }
  const fence = Math.max(...fences)
  return {
    kind: 'item',
    // Stable owner identity lets later runtimes find the same notice.
    identity: {
      provider: 'orca',
      clientMessageId: `${STALE_SESSION_ROW_PREFIX}${input.sessionId}:replaced-${fence}`
    },
    body: orcaStopRowBody(
      input.failureTextContext,
      fence === input.replaced.fence ? input.replaced.runtimeEnd : undefined
    )
  }
}
