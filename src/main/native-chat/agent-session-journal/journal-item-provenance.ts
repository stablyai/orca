// Execution provenance: the generation whose execution produced an item (`JournalItemRow.ownerFence`)
// and each entry of a container row.
//
// Each entry of a container row: every subagent roster entry and every
// background task. One roster row is revised in place across generations (a resumed provider keeps
// the group's identity), so the row's own provenance cannot say which generation each child
// belongs to. A provider's observation stamps the entries it changed or added with its own
// generation; an entry it carries unchanged keeps the one it had (or, never stamped, the row's
// earlier provenance). Host bookkeeping states no provenance and stamps nothing.

import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import {
  isBackgroundTaskBlock,
  isSubagentGroupBlock,
  type NativeChatBlock
} from '../../../shared/native-chat-types'

type Entry = { ownerFence?: number }

/** An entry's observed fields, in a fixed order: its provenance is not part of what was seen. */
function observationKey(entry: Entry): string {
  const { ownerFence: _ownerFence, ...fields } = entry
  return JSON.stringify(Object.entries(fields).sort(([left], [right]) => left.localeCompare(right)))
}

function stamp<T extends Entry>(
  entry: T,
  previous: T | undefined,
  previousItemFence: number | undefined,
  ownerFence: number
): T {
  if (previous && observationKey(previous) === observationKey(entry)) {
    const kept = previous.ownerFence ?? previousItemFence
    return kept === undefined || kept === entry.ownerFence ? entry : { ...entry, ownerFence: kept }
  }
  // No earlier entry to compare: one that already names its generation (history carried into a new
  // epoch) keeps it.
  if (!previous && entry.ownerFence !== undefined) {
    return entry
  }
  return entry.ownerFence === ownerFence ? entry : { ...entry, ownerFence }
}

function hasEntries(body: AgentJournalItemBody): boolean {
  return (
    body.kind === 'message' &&
    body.blocks.some((block) => isSubagentGroupBlock(block) || isBackgroundTaskBlock(block))
  )
}

/** The body as written by an observation of generation `ownerFence`, each entry stamped. */
export function stampJournalEntryProvenance(
  body: AgentJournalItemBody,
  previous: { body: AgentJournalItemBody; ownerFence?: number } | undefined,
  ownerFence: number
): AgentJournalItemBody {
  if (body.kind !== 'message' || !hasEntries(body)) {
    return body
  }
  const earlier: readonly NativeChatBlock[] =
    previous?.body.kind === 'message' ? previous.body.blocks : []
  const blocks = body.blocks.map((block): NativeChatBlock => {
    if (isSubagentGroupBlock(block)) {
      const group = earlier.find(
        (candidate) => isSubagentGroupBlock(candidate) && candidate.groupId === block.groupId
      )
      const agents = group && isSubagentGroupBlock(group) ? group.agents : []
      return {
        ...block,
        agents: block.agents.map((agent) =>
          stamp(
            agent,
            agents.find((candidate) => candidate.id === agent.id),
            previous?.ownerFence,
            ownerFence
          )
        )
      }
    }
    if (isBackgroundTaskBlock(block)) {
      const task = earlier.find(
        (candidate) => isBackgroundTaskBlock(candidate) && candidate.taskId === block.taskId
      )
      return stamp(
        block,
        task && isBackgroundTaskBlock(task) ? task : undefined,
        previous?.ownerFence,
        ownerFence
      )
    }
    return block
  })
  return { ...body, blocks }
}

/** An entry's generation: its own stamp, else the row's provenance. */
export function journalEntryOwnerFence(
  entry: Entry,
  itemFence: number | undefined
): number | undefined {
  return entry.ownerFence ?? itemFence
}

/** The provenance a row states: the writer's own claim when it has one — a provider's observation,
 *  or history carried into a new epoch — else host bookkeeping's, which keeps the item's, and for
 *  an item it creates is the fence it writes at. Every item row states it. */
export function journalItemOwnerFence(
  state: Pick<JournalReducerState, 'itemFences' | 'items'>,
  resolvedItemId: string,
  write: { fence: number; ownerFence?: number }
): number {
  if (write.ownerFence !== undefined) {
    return write.ownerFence
  }
  const kept = state.items.has(resolvedItemId) ? state.itemFences.get(resolvedItemId) : undefined
  return kept ?? write.fence
}

/** A provider's observation stamps each roster entry and background task it saw
 *  (`stampJournalEntryProvenance`); host bookkeeping states no provenance and stamps nothing. */
export function journalObservedBody(
  state: Pick<JournalReducerState, 'itemFences' | 'items'>,
  resolvedItemId: string,
  body: AgentJournalItemBody,
  ownerFence: number | undefined
): AgentJournalItemBody {
  if (ownerFence === undefined) {
    return body
  }
  const previous = state.items.get(resolvedItemId)
  return stampJournalEntryProvenance(
    body,
    previous && { body: previous.body, ownerFence: state.itemFences.get(resolvedItemId) },
    ownerFence
  )
}
