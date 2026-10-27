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

/** get_entries returns append order, including abandoned branches. */
export const piEntriesAnswerSchema = z.object({
  entries: z.array(piEntrySchema),
  leafId: z.string().min(1).nullable()
})
export type PiEntriesAnswer = z.infer<typeof piEntriesAnswerSchema>

/** Walk from the leaf to the claim; null requires a whole-tree read to place an earlier rewind. */
export function piBranchSince(
  answer: PiEntriesAnswer,
  claim: string
): { path: PiSessionEntry[]; rewound: false } | null {
  const walked = walkFromLeaf(answer, (id) => id === claim)
  return walked?.stop === claim ? { path: walked.path, rewound: false } : null
}

/** Read the active branch after the claim or its nearest shared ancestor; unknown claims refuse import. */
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
    // Deleting visited IDs bounds cycles as incomplete history.
    byId.delete(current)
    path.push(entry)
    current = entry.parentId
  }
  return { path: path.toReversed(), stop: current }
}

/** Match adoption identities so both import paths deduplicate. */
export function piHistoryEntryIdentity(
  sessionFile: string,
  entryId: string
): AgentJournalItemIdentity {
  return { provider: 'legacy', agent: 'pi', sessionId: sessionFile, recordId: entryId }
}

/** Stage all outside rows before writing; exclude journaled entries so prior imports cannot veto newer ones. */
export function createPiHistoryImportPlan(input: {
  sessionFile: string
  journal: StructuredAgentSessionTransitionJournal
  path: readonly PiSessionEntry[]
  rewound: boolean
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
    // History imports must never become sends eligible for delivery recovery.
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
