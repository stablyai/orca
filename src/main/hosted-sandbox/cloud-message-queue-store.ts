// Queued prompts on disk: sealed with the OS keychain; without one they live in memory only.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { CloudQueuedPrompt } from '../../shared/hosted-sandbox/cloud-workspace-offline-api'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { OfflineCacheCodec } from './cloud-offline-cache'

export type StoredPrompt = CloudQueuedPrompt & {
  clientOperationId: string
  /** Failed attempts (wake, transport, refusal-to-retry); the prompt fails at the budget. */
  failures: number
  /** No background attempt before this (backoff). */
  nextAttemptAt: number
}

// The sealed file is ours, but only its shape is checked here; a prompt that does not match is dropped.
const StoredPromptSchema = z.looseObject({
  id: z.string(),
  clientOperationId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  text: z.string(),
  state: z.enum(['queued', 'sending', 'delivered', 'failed', 'unconfirmed']),
  createdAt: z.number(),
  updatedAt: z.number(),
  failures: z.number(),
  nextAttemptAt: z.number(),
  error: z.string().optional()
})
const SealedQueueSchema = z.object({ version: z.literal(2), prompts: z.array(z.unknown()) })

export async function readSealedPrompts(
  path: string,
  codec: OfflineCacheCodec | null
): Promise<StoredPrompt[]> {
  if (!codec) {
    return []
  }
  try {
    const parsed = SealedQueueSchema.safeParse(JSON.parse(codec.decrypt(await readFile(path))))
    if (!parsed.success) {
      return []
    }
    return parsed.data.prompts.flatMap((raw) => {
      const prompt = StoredPromptSchema.safeParse(raw)
      return prompt.success ? [prompt.data] : []
    })
  } catch {
    return []
  }
}

export async function writeSealedPrompts(
  path: string,
  codec: OfflineCacheCodec | null,
  prompts: readonly StoredPrompt[]
): Promise<void> {
  if (!codec) {
    return
  }
  const sealed = codec.encrypt(JSON.stringify({ version: 2, prompts }))
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, sealed, { mode: 0o600 })
  await rename(temp, path)
}

/** The first build kept the queue as plaintext JSON beside the sealed file; it is never read. */
export function removeLegacyPlaintextQueue(path: string): Promise<void> {
  return rm(join(dirname(path), 'orca-cloud-queued-prompts.json'), { force: true })
}

/** The sealed queue file: read once, then every write and removal in call order. */
export function createSealedPromptDisk(
  path: string,
  codec: OfflineCacheCodec | null,
  log: (line: string) => void
) {
  const load = (async () => {
    await removeLegacyPlaintextQueue(path).catch(() => undefined)
    return readSealedPrompts(path, codec)
  })()
  // Nothing is written before the sealed file has been read.
  let tail: Promise<unknown> = load
  function serial(task: () => Promise<void>): Promise<void> {
    const run = tail.then(task)
    tail = run.catch((error: unknown) =>
      log(`[orca-cloud] queued prompts write failed: ${String(error)}`)
    )
    return run
  }
  return {
    load,
    write: (prompts: readonly StoredPrompt[]) =>
      serial(() => writeSealedPrompts(path, codec, prompts)),
    remove: () =>
      serial(async () => {
        await removeLegacyPlaintextQueue(path)
        await rm(path, { force: true })
      }),
    flushed: () => serial(async () => {})
  }
}

export function earliestOwedAttempt(prompts: readonly StoredPrompt[]): number | null {
  let earliest: number | null = null
  for (const prompt of prompts) {
    if (prompt.state === 'queued' || prompt.state === 'sending') {
      earliest = earliest === null ? prompt.nextAttemptAt : Math.min(earliest, prompt.nextAttemptAt)
    }
  }
  return earliest
}

/** Refusals that mean "not now", not "never": the same operation is sent again. */
export const RETRYABLE_REFUSALS = new Set([
  'agent_session_checkpoint_stale',
  'execution_owner_reconciling',
  'agent_session_ownership_unknown',
  'agent_session_operation_capacity'
])

export function publicView(prompt: StoredPrompt): CloudQueuedPrompt {
  const { clientOperationId: _id, failures: _f, nextAttemptAt: _n, ...view } = prompt
  return view
}

type FenceCall = (
  environmentId: string,
  method: string,
  params: unknown,
  timeoutMs: number
) => Promise<RuntimeRpcResponse<unknown>>

/** The session's fence; `refused` when the host says the chat is gone; null to retry later. */
export async function currentFence(
  call: FenceCall,
  environmentId: string,
  sessionId: string
): Promise<number | { refused: string } | null> {
  const response = await call(
    environmentId,
    'agentSession.history',
    { sessionId, direction: 'tail', limit: 1 },
    20_000
  )
  if (!response.ok) {
    // A session refusal is final (the chat was closed or never existed here); anything else
    // (asleep, unreachable, timeout) is the transport and is retried.
    const code = response.error.code
    return code.startsWith('agent_session_') && !RETRYABLE_REFUSALS.has(code)
      ? { refused: code }
      : null
  }
  const parsed = FenceResultSchema.safeParse(response.result)
  const result = parsed.success ? parsed.data : { ok: false }
  const fence = result.page?.fence ?? (result.ok ? undefined : result.fence)
  return typeof fence === 'number' ? fence : null
}

const FenceResultSchema = z.looseObject({
  ok: z.boolean(),
  page: z.looseObject({ fence: z.number().optional() }).optional(),
  fence: z.number().optional()
})

/** `agentSession.send` answer: delivered, or refused with a code. */
export const SendResultSchema = z.looseObject({
  ok: z.boolean(),
  refusal: z.looseObject({ code: z.string().optional(), message: z.string().optional() }).optional()
})

export type WorkspaceAvailability =
  | { kind: 'up'; environmentId: string }
  | { kind: 'asleep'; environmentId: string }
  /** Archived or manually disconnected: nothing wakes it or sends to it. */
  | { kind: 'blocked'; reason: string }
  | { kind: 'gone' }

export type CloudMessageQueueDeps = {
  path: string
  /** Null: the OS cannot seal files, so the queue lives in memory only. */
  codec: OfflineCacheCodec | null
  now?: () => number
  locate: (workspaceId: string) => Promise<WorkspaceAvailability>
  /** Wake through the ordinary path; true once orcad is up. */
  wake: (workspaceId: string) => Promise<boolean>
  call: (
    environmentId: string,
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<RuntimeRpcResponse<unknown>>
  onChange?: (workspaceId: string) => void
  log?: (line: string) => void
}

export type CloudMessageQueue = {
  /** Queue and deliver (waking the VM: the person asked for it). Rejects blocked workspaces. */
  enqueue(args: {
    workspaceId: string
    sessionId: string
    text: string
  }): Promise<CloudQueuedPrompt>
  list(workspaceId: string): CloudQueuedPrompt[]
  cancel(id: string): boolean
  edit(id: string, text: string): boolean
  /** Background pass: deliver to VMs that are already up; never wakes. */
  drive(workspaceId?: string): Promise<void>
  /** The workspace was slept, archived or removed: queued prompts fail instead of waiting. */
  failPending(workspaceId: string, reason: string): void
  /** Sign-out / profile switch: forget everything. */
  clear(): void
  /** Resolves once every disk write requested so far has finished (shutdown, tests). */
  flushed(): Promise<void>
  /** Earliest background attempt still owed (ms epoch), or null when nothing is pending. */
  nextAttemptAt(): number | null
}
