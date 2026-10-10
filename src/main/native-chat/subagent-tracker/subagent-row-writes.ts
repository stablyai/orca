// Writing a group's row: one dedupe and one refusal rule for every agent.

import { subagentGroupJournalBody } from '../agent-session-journal/journal-subagent-group-body'
import type { StructuredAgentSessionSinkAdmission } from '../agent-session-wire/structured-agent-session-event-sink'
import type { SubagentGroup, SubagentRowPort } from './subagent-tracker-types'

/** Writes each group whose row changed. The dedupe advances only once a revision is both queued and
 *  published, so a refused one is written again by the next write of that group; the first refusal
 *  is handed back after every group was tried. */
export function writeSubagentRows<Placement>(
  groups: Iterable<SubagentGroup<Placement>>,
  port: SubagentRowPort<Placement>
): StructuredAgentSessionSinkAdmission | null {
  let refused: StructuredAgentSessionSinkAdmission | null = null
  for (const group of groups) {
    const agents = [...group.entries.values()].map((tracked) => tracked.entry)
    const body = subagentGroupJournalBody(group.groupId, agents)
    const serialized = JSON.stringify(body)
    if (serialized === group.lastSerialized) {
      // A duplicate delivery must not burn a revision.
      continue
    }
    // A group that lost its last child removes its row.
    const admission = port.write(group, { body: agents.length > 0 ? body : null, serialized })
    group.lastSerialized = admission.accepted ? serialized : null
    refused ??= admission.accepted ? null : admission
  }
  return refused
}
