// The row a stale settle writes about why the turns it cut stopped: a death that names their owner,
// or the replacement of the Orca runtime that held them. One row per proof, named by it, so a retry
// after a partly written settle adds no second row.

import { STALE_SESSION_ROW_PREFIX } from '../../../shared/agent-session-stop-row-identity'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalRenderItem,
  AgentJournalStatusItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionReplacedRuntime } from '../../runtime/agent-session-replaced-runtime'
import { orcaStopRowBody } from './structured-agent-session-orca-stop-row'

/** Which proof ends an item the settle found running or left `unverifiable`, if any does. */
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
  // The death evidence is Orca's log text, never a sentence for a person: the row says only that
  // the provider stopped, and how Orca ended when the provider died with it.
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
    // Named by the owner it explains, which every later runtime finds the same.
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
