import { isTmuxInnerSubject } from '../../../shared/tmux-selected-status'
import {
  getLegacyStatusListingOrder,
  type HookListenerState
} from '../../../shared/agent-hook-listener/listener-state'
import {
  serializeAgentStatusSubject,
  type AgentStatusSubject
} from '../../../shared/agent-status/contracts/agent-status-subject'
import type { AgentStatusStore } from '../../../shared/agent-status/store/agent-status-store'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { structuredStatusLegacyEvent } from './server-structured-status-row'
import type { ProgramStatusFacetStore } from './program-status/facet-store'
import type { RowAgentIdentity } from '../identity/pane-agent-identities'

const UNORDERED_STATUS_ROW = Number.MAX_SAFE_INTEGER

export function combinedAgentStatusEntries(
  source: {
    state: HookListenerState
    programStatusFacets: Pick<ProgramStatusFacetStore, 'stitch'>
    /** A canonical terminal status's id, assigned when it was committed; absent for outputs
     *  that carry no id. */
    canonicalIdentity?: (subjectKey: string) => RowAgentIdentity | undefined
    canonicalStatusStore: Pick<AgentStatusStore, 'getParents' | 'getParent'>
    canonicalSubjectsByPane: ReadonlyMap<string, ReadonlyMap<string, AgentStatusSubject>>
    canonicalListingOrder: ReadonlyMap<string, number>
  },
  paneKey?: string
): EnrichedAgentHookEventPayload[] {
  const rows: { entry: EnrichedAgentHookEventPayload; order: number }[] = []
  const legacy =
    paneKey === undefined
      ? source.state.lastStatusByPaneKey
      : source.state.lastStatusByPaneKey.has(paneKey)
        ? [[paneKey, source.state.lastStatusByPaneKey.get(paneKey)!] as const]
        : []
  for (const [paneKey, entry] of legacy) {
    rows.push({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; shared listeners expose only the base event type.
      entry: source.programStatusFacets.stitch(entry as EnrichedAgentHookEventPayload),
      order: getLegacyStatusListingOrder(source.state, paneKey) ?? UNORDERED_STATUS_ROW
    })
  }
  const parents =
    paneKey === undefined
      ? source.canonicalStatusStore.getParents()
      : [...(source.canonicalSubjectsByPane.get(paneKey)?.values() ?? [])].flatMap(
          (subject) => source.canonicalStatusStore.getParent(subject) ?? []
        )
  for (const parent of parents) {
    if (!parent.status || isTmuxInnerSubject(parent.subject)) {
      continue
    }
    const subjectKey = serializeAgentStatusSubject(parent.subject)
    const entry = structuredStatusLegacyEvent(parent.status)
    const agentIdentity =
      entry.structuredHost || !source.canonicalIdentity
        ? undefined
        : source.canonicalIdentity(subjectKey)
    rows.push({
      entry: agentIdentity ? { ...entry, agentIdentity } : entry,
      order: source.canonicalListingOrder.get(subjectKey) ?? UNORDERED_STATUS_ROW
    })
  }
  return rows.sort((a, b) => a.order - b.order).map(({ entry }) => entry)
}
