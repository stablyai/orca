import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from '../../../src/shared/agent-session-host-authority'
import { AGENT_SESSION_DURABLE_OPERATION_GLOBAL_LIMIT } from '../../../src/shared/agent-session-operation-ledger'
import { structuredAgentSessionPayloadFingerprint } from '../../../src/shared/structured-agent-session-mutation'

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

export function mobileStructuredSendOperationKey(input: {
  sessionKey: string
  intentFingerprint: string
}): string {
  return structuredAgentSessionPayloadFingerprint({
    method: 'mobile.agentSession.send.operation',
    sessionId: input.sessionKey,
    fields: { intentFingerprint: input.intentFingerprint }
  })
}

export function mobileStructuredSendCallerFingerprint(callerIdentity: string): string {
  return structuredAgentSessionPayloadFingerprint({
    method: 'mobile.agentSession.send.caller',
    sessionId: callerIdentity,
    fields: {}
  })
}

function newOperationIdIsAdmissible(operationId: string, now: number): boolean {
  const timestamp = parseAgentSessionOperationTimestamp(operationId)
  return (
    timestamp !== null &&
    timestamp <= now + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS &&
    now - timestamp <= AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS
  )
}

function parseJournal(raw: string | null): OperationJournal {
  if (raw === null) {
    return { v: 1, entries: [] }
  }
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
  if (entries.length === 0) {
    await AsyncStorage.removeItem(STORAGE_KEY)
    return
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, entries }))
}

async function serialize<T>(action: () => Promise<T>): Promise<T> {
  const operation = mutations.tail.then(action, action)
  mutations.tail = operation.then(
    () => undefined,
    () => undefined
  )
  return operation
}

export async function getOrCreateMobileStructuredSendOperation(input: {
  operationKey: string
  callerIdentity: string
  payloadFingerprint: string
  attachmentPaths: readonly string[]
  createOperationId: () => string
  now?: number
}): Promise<{
  operationId: string
  retained: boolean
  payloadFingerprint: string
  attachmentPaths: string[]
}> {
  return serialize(async () => {
    const now = input.now ?? Date.now()
    const callerFingerprint = mobileStructuredSendCallerFingerprint(input.callerIdentity)
    const journal = parseJournal(await AsyncStorage.getItem(STORAGE_KEY))
    const entries = journal.entries
    const existing = entries.find((entry) => entry.operationKey === input.operationKey)
    if (existing) {
      if (existing.callerFingerprint !== callerFingerprint) {
        throw new Error('Structured send caller identity changed')
      }
      return {
        operationId: existing.operationId,
        retained: true,
        payloadFingerprint: existing.payloadFingerprint,
        attachmentPaths: [...existing.attachmentPaths]
      }
    }
    // Ambiguity has no TTL. At the fixed capacity, refusing a new send is safer
    // than evicting an id whose message may already be in provider context.
    if (entries.length >= AGENT_SESSION_DURABLE_OPERATION_GLOBAL_LIMIT) {
      throw new Error('Structured send operation journal is full')
    }
    const operationId = input.createOperationId()
    if (!newOperationIdIsAdmissible(operationId, now)) {
      throw new Error('Structured send operation id is invalid')
    }
    const entry = OperationEntrySchema.parse({
      operationKey: input.operationKey,
      operationId,
      callerFingerprint,
      payloadFingerprint: input.payloadFingerprint,
      attachmentPaths: [...input.attachmentPaths]
    })
    await writeEntries([...entries, entry])
    return {
      operationId,
      retained: false,
      payloadFingerprint: input.payloadFingerprint,
      attachmentPaths: [...input.attachmentPaths]
    }
  })
}

export async function clearMobileStructuredSendOperation(input: {
  operationKey: string
  operationId: string
}): Promise<void> {
  return serialize(async () => {
    const journal = parseJournal(await AsyncStorage.getItem(STORAGE_KEY))
    const entries = journal.entries
    const existing = entries.find((entry) => entry.operationKey === input.operationKey)
    if (!existing) {
      return
    }
    if (existing.operationId !== input.operationId) {
      throw new Error('Structured send operation identity changed')
    }
    await writeEntries(entries.filter((entry) => entry !== existing))
  })
}

/** Reconcile an ack-lost operation once the authoritative journal settles it. */
export async function clearMobileStructuredSettledSendOperations(input: {
  submissions: readonly AgentJournalSubmission[]
}): Promise<void> {
  const settled = new Set(
    input.submissions.flatMap((submission) =>
      submission.dispatchState === 'accepted' || submission.dispatchState === 'rejected'
        ? [`${submission.payloadFingerprint}\u0000${submission.clientMessageId}`]
        : []
    )
  )
  if (settled.size === 0) {
    return
  }
  return serialize(async () => {
    const journal = parseJournal(await AsyncStorage.getItem(STORAGE_KEY))
    const entries = journal.entries.filter(
      (entry) => !settled.has(`${entry.payloadFingerprint}\u0000${entry.operationId}`)
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
