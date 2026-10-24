import { z } from 'zod'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { legacyItemBody } from '../native-chat/agent-session-journal/journal-legacy-import'
import { decodePiSessionEntryLine } from '../native-chat/agent-session-journal/journal-pi-active-branch'
import { journalLifecycleItemMutation } from '../native-chat/agent-session-journal/journal-row-builders'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import {
  continuedOutsideNotice,
  continuedOutsideRecordId,
  createHistoryCatchUpBatch,
  type HistoryCatchUpPlan
} from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'

const piEntrySchema = z.looseObject({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  type: z.string()
})
export type PiSessionEntry = z.infer<typeof piEntrySchema>

/** `get_entries`: the entries after `since` in the order Pi appended them, and its leaf. */
export const piEntriesAnswerSchema = z.object({
  entries: z.array(piEntrySchema),
  leafId: z.string().min(1).nullable()
})
export type PiEntriesAnswer = z.infer<typeof piEntriesAnswerSchema>

/** The answer to `get_entries since: claim`: the active branch after the claim, oldest first, when
 *  the leaf's `parentId` chain reaches the claim inside it; null when the terminal went back to an
 *  earlier point, which only the whole tree can place. The answer lists in append order and keeps
 *  abandoned branches, so the branch is always walked from the leaf. */
export function piBranchSince(
  answer: PiEntriesAnswer,
  claim: string
): { path: PiSessionEntry[]; rewound: false } | null {
  const walked = walkFromLeaf(answer, (id) => id === claim)
  return walked?.stop === claim ? { path: walked.path, rewound: false } : null
}

/**
 * The whole tree's active branch after the newest entry the chat accounts for: the claim, or the
 * nearest of its ancestors where the terminal branched off (rewound). Without a claim, the whole
 * branch. 'unknown-claim' when the claim isn't in this conversation at all.
 */
export function piBranchInTree(
  answer: PiEntriesAnswer,
  claim: string | null
): { path: PiSessionEntry[]; rewound: boolean } | 'unknown-claim' | null {
  const byId = new Map(answer.entries.map((entry) => [entry.id, entry]))
  const accounted = new Set<string>()
  for (let id = claim; id !== null && !accounted.has(id); id = byId.get(id)?.parentId ?? null) {
    if (!byId.has(id)) {
      return 'unknown-claim'
    }
    accounted.add(id)
  }
  const walked = walkFromLeaf(answer, (id) => accounted.has(id))
  if (!walked) {
    return null
  }
  return { path: walked.path, rewound: walked.stop !== claim }
}

function walkFromLeaf(
  answer: PiEntriesAnswer,
  stopsAt: (id: string) => boolean
): { path: PiSessionEntry[]; stop: string | null } | null {
  const byId = new Map(answer.entries.map((entry) => [entry.id, entry]))
  const path: PiSessionEntry[] = []
  let current = answer.leafId
  while (current !== null && !stopsAt(current)) {
    const entry = byId.get(current)
    if (!entry) {
      return null
    }
    // Each id is visited once: a cycle ends the walk as incomplete history.
    byId.delete(current)
    path.push(entry)
    current = entry.parentId
  }
  return { path: path.toReversed(), stop: current }
}

/** Rows keyed as adoption keys them (`legacy/pi/<session file>/<entry id>`), so both dedupe. */
export function piHistoryEntryIdentity(
  sessionFile: string,
  entryId: string
): AgentJournalItemIdentity {
  return { provider: 'legacy', agent: 'pi', sessionId: sessionFile, recordId: entryId }
}

/** Outside entries as journal rows, staged whole before anything is written; entries the journal
 *  already holds are left out first, so an earlier import never vetoes newer entries. Null when
 *  nothing on the path shows as a row. */
export function createPiHistoryImportPlan(input: {
  sessionFile: string
  journal: StructuredAgentSessionTransitionJournal
  path: readonly PiSessionEntry[]
  rewound: boolean
  /** Only a chat that already shows something needs the divider. */
  divider: boolean
  check: () => void
}): HistoryCatchUpPlan | null {
  const batch = createHistoryCatchUpBatch()
  const entryIds: string[] = []
  for (const entry of input.path) {
    input.check()
    const identity = piHistoryEntryIdentity(input.sessionFile, entry.id)
    if (input.journal.item(input.journal.canonicalItemId(agentJournalItemKey(identity))) !== null) {
      continue
    }
    const message = decodePiSessionEntryLine(JSON.stringify(entry), entry.id)
    if (!message) {
      continue
    }
    const body = legacyItemBody(message)
    if (entryIds.length === 0 && input.divider) {
      batch.push(
        journalLifecycleItemMutation(
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE },
          piHistoryEntryIdentity(input.sessionFile, continuedOutsideRecordId(entry.id)),
          continuedOutsideNotice(input.rewound)
        )
      )
    }
    // Imported prompts are history, never sends delivery recovery could claim.
    batch.push(
      journalLifecycleItemMutation(
        {
          turnScope: AGENT_JOURNAL_THREAD_SCOPE,
          ...(body.kind === 'message' && body.role === 'user' ? { echoOf: null } : {})
        },
        identity,
        body
      )
    )
    entryIds.push(entry.id)
  }
  return batch.size === 0
    ? null
    : batch.finish('pi-history-import', [input.journal.epoch, input.sessionFile, entryIds])
}
