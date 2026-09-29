import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'
import { persistMirrored } from '../storage/mirrored-storage-keys'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import {
  AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS,
  parseAgentSessionOperationTimestamp
} from '../../../src/shared/agent-session-host-authority'
import { AGENT_SESSION_DURABLE_OPERATION_GLOBAL_LIMIT } from '../../../src/shared/agent-session-operation-ledger'

// Older builds and host-served pages keyed a send by its text here; this build only drains it.
const STORAGE_KEY = 'orca:mobileStructuredSendOperations:v1'
const OperationEntrySchema = z
  .object({
    operationKey: z.string().regex(/^[0-9a-f]{64}$/),
    operationId: z.string().max(128),
    callerFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    payloadFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    attachmentPaths: z.array(z.string().max(4096)).max(128)
  })
  .strict()
const OperationJournalSchema = z
  .object({
    v: z.literal(1),
    entries: z.array(OperationEntrySchema).max(AGENT_SESSION_DURABLE_OPERATION_GLOBAL_LIMIT)
  })
  .strict()

type OperationEntry = z.infer<typeof OperationEntrySchema>
type OperationJournal = z.infer<typeof OperationJournalSchema>

const mutations: { tail: Promise<void> } = { tail: Promise.resolve() }

function parseJournal(raw: string): OperationJournal {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Structured send operation journal is unreadable')
  }
  const parsed = OperationJournalSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('Structured send operation journal is unreadable')
  }
  if (
    new Set(parsed.data.entries.map((entry) => entry.operationKey)).size !==
      parsed.data.entries.length ||
    parsed.data.entries.some(
      (entry) => parseAgentSessionOperationTimestamp(entry.operationId) === null
    )
  ) {
    throw new Error('Structured send operation journal is unreadable')
  }
  return parsed.data
}

async function writeEntries(entries: OperationEntry[]): Promise<void> {
  // Through the one write path, which notes the mirror on an accepted write and on nothing else
  // (ruling 35).
  await persistMirrored(
    STORAGE_KEY,
    entries.length === 0 ? null : JSON.stringify({ v: 1, entries })
  )
}

async function serialize<T>(action: () => Promise<T>): Promise<T> {
  const operation = mutations.tail.then(action, action)
  mutations.tail = operation.then(
    () => undefined,
    () => undefined
  )
  return operation
}

/** Drops entries the host shows settled, and entries past the host's replay window. */
export async function reconcileMobileStructuredSendOperations(input: {
  submissions: readonly AgentJournalSubmission[]
  now?: number
}): Promise<void> {
  const settled = new Set(
    input.submissions.flatMap((submission) =>
      submission.dispatchState === 'accepted' || submission.dispatchState === 'rejected'
        ? [`${submission.payloadFingerprint}\u0000${submission.clientMessageId}`]
        : []
    )
  )
  return serialize(async () => {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (raw === null) {
      return
    }
    const journal = parseJournal(raw)
    const now = input.now ?? Date.now()
    const entries = journal.entries.filter(
      (entry) =>
        !settled.has(`${entry.payloadFingerprint}\u0000${entry.operationId}`) &&
        now - (parseAgentSessionOperationTimestamp(entry.operationId) ?? now) <=
          AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS
    )
    if (entries.length !== journal.entries.length) {
      await writeEntries(entries)
    }
  })
}

/** Test-only: drain in-memory serialization while preserving durable storage. */
export function resetMobileStructuredSendOperationJournalForTests(): void {
  mutations.tail = Promise.resolve()
}
