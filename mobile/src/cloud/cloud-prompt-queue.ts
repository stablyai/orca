import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import { structuredSessionOperationId } from '../session/structured-session-operation-id'

// Prompts typed for a sleeping cloud workspace. They stay on the phone (the control plane must
// never hold prompt text in the clear) until the VM is up and the phone delivers them over E2EE.

const QUEUE_KEY = 'orca:cloud-prompt-queue:v1'
const MAX_QUEUED_PER_WORKSPACE = 20

const QueuedPromptSchema = z.object({
  id: z.string(),
  sandboxId: z.string(),
  text: z.string().min(1).max(20_000),
  agent: z.string().min(1),
  createdAt: z.number(),
  /** Reused on every retry so a reply lost mid-launch never starts a second agent. */
  operationId: z.string(),
  status: z.enum(['queued', 'delivering', 'failed']),
  /** A code the screen maps to words (see cloud-workspace-copy.ts); never raw host text. */
  error: z.string().optional()
})
export type QueuedCloudPrompt = z.infer<typeof QueuedPromptSchema>

const listeners = new Set<() => void>()
let mutation: Promise<unknown> = Promise.resolve()

async function read(): Promise<QueuedCloudPrompt[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY)
  try {
    const value: unknown = raw ? JSON.parse(raw) : []
    // Entry by entry: one bad record must not drop every other waiting prompt.
    return Array.isArray(value)
      ? value.flatMap((entry) => {
          const parsed = QueuedPromptSchema.safeParse(entry)
          return parsed.success ? [parsed.data] : []
        })
      : []
  } catch {
    // A corrupt value must not wedge the queue forever; it is replaced on the next write.
    return []
  }
}

function mutate<T>(
  change: (queue: QueuedCloudPrompt[]) => { next: QueuedCloudPrompt[]; result: T }
): Promise<T> {
  const run = mutation.then(async () => {
    const { next, result } = change(await read())
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(next))
    listeners.forEach((listener) => listener())
    return result
  })
  mutation = run.catch(() => undefined)
  return run
}

export async function listQueuedCloudPrompts(sandboxId: string): Promise<QueuedCloudPrompt[]> {
  return (await read()).filter((prompt) => prompt.sandboxId === sandboxId)
}

export function enqueueCloudPrompt(args: {
  sandboxId: string
  text: string
  agent: string
  operationId: string
  now?: number
}): Promise<QueuedCloudPrompt> {
  return mutate((queue) => {
    const prompt: QueuedCloudPrompt = {
      id: randomV4Uuid(),
      sandboxId: args.sandboxId,
      text: args.text,
      agent: args.agent,
      createdAt: args.now ?? Date.now(),
      operationId: args.operationId,
      status: 'queued'
    }
    const mine = queue.filter((entry) => entry.sandboxId === args.sandboxId)
    if (mine.length >= MAX_QUEUED_PER_WORKSPACE) {
      throw new Error('cloud_prompt_queue_full')
    }
    return { next: [...queue, prompt], result: prompt }
  })
}

export function markCloudPrompt(
  id: string,
  update: Pick<QueuedCloudPrompt, 'status'> & { error?: string }
): Promise<void> {
  return mutate((queue) => ({
    next: queue.map((entry) =>
      entry.id === id
        ? {
            ...entry,
            status: update.status,
            ...(update.error ? { error: update.error } : { error: undefined })
          }
        : entry
    ),
    result: undefined
  }))
}

export function markWaitingCloudPromptsFailed(sandboxId: string, error: string): Promise<void> {
  return mutate((queue) => ({
    next: queue.map((entry) =>
      entry.sandboxId === sandboxId && entry.status === 'queued'
        ? { ...entry, status: 'failed' as const, error }
        : entry
    ),
    result: undefined
  }))
}

/** Never sent (the phone couldn't connect): keep the operation id. The host answered with a failure:
 *  its ledger replays that answer for the same id, so a real retry needs a new one. */
function retried(entry: QueuedCloudPrompt): QueuedCloudPrompt {
  // Never sent, or the reply was lost: the same id lets the host dedupe instead of launching twice.
  const neverSent = entry.error === 'not_connected' || entry.error === 'transport_lost'
  return {
    ...entry,
    status: 'queued',
    error: undefined,
    operationId: neverSent ? entry.operationId : structuredSessionOperationId()
  }
}

export function retryCloudPrompt(id: string): Promise<void> {
  return mutate((queue) => ({
    next: queue.map((entry) =>
      entry.id === id && entry.status === 'failed' ? retried(entry) : entry
    ),
    result: undefined
  }))
}

/** Prompts held back only because the phone couldn't connect go out with the next attach. */
export function requeueUnsentCloudPrompts(sandboxId: string): Promise<void> {
  return mutate((queue) => ({
    next: queue.map((entry) =>
      entry.sandboxId === sandboxId && entry.status === 'failed' && entry.error === 'not_connected'
        ? retried(entry)
        : entry
    ),
    result: undefined
  }))
}

export function removeCloudPrompt(id: string): Promise<void> {
  return mutate((queue) => ({ next: queue.filter((entry) => entry.id !== id), result: undefined }))
}

/** The workspaces are gone: nothing queued for them can ever be delivered. */
export function removeCloudPromptsFor(sandboxIds: ReadonlySet<string>): Promise<void> {
  return mutate((queue) => ({
    next: queue.filter((entry) => !sandboxIds.has(entry.sandboxId)),
    result: undefined
  }))
}

export function subscribeCloudPromptQueue(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const inFlight = new Set<string>()

/** Waiting prompts go out in order; failed ones wait for the user's Retry so one bad prompt never
 *  blocks the rest. `delivering` ones (app killed mid-send) are resent with the same operation id,
 *  which the host's durable launch ledger deduplicates. One run per workspace at a time. */
export async function deliverQueuedCloudPrompts(
  sandboxId: string,
  deliver: (prompt: QueuedCloudPrompt) => Promise<void>,
  errorCodeFor: (error: unknown) => string
): Promise<{ delivered: number; failed: QueuedCloudPrompt[] }> {
  if (inFlight.has(sandboxId)) {
    return { delivered: 0, failed: [] }
  }
  inFlight.add(sandboxId)
  let delivered = 0
  const failed: QueuedCloudPrompt[] = []
  try {
    for (const prompt of await listQueuedCloudPrompts(sandboxId)) {
      if (prompt.status === 'failed') {
        continue
      }
      await markCloudPrompt(prompt.id, { status: 'delivering' })
      try {
        await deliver(prompt)
        await removeCloudPrompt(prompt.id)
        delivered += 1
      } catch (error) {
        const code = errorCodeFor(error)
        await markCloudPrompt(prompt.id, { status: 'failed', error: code })
        failed.push({ ...prompt, status: 'failed', error: code })
      }
    }
  } finally {
    inFlight.delete(sandboxId)
  }
  return { delivered, failed }
}
