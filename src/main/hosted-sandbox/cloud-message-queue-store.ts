// Queued prompts on disk: sealed with the OS keychain; without one they live in memory only.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

export function readSealedPrompts(path: string, codec: OfflineCacheCodec | null): StoredPrompt[] {
  if (!codec) {
    return []
  }
  try {
    const parsed = JSON.parse(codec.decrypt(readFileSync(path))) as {
      version: 2
      prompts: StoredPrompt[]
    }
    return parsed.version === 2 && Array.isArray(parsed.prompts) ? parsed.prompts : []
  } catch {
    return []
  }
}

export function writeSealedPrompts(
  path: string,
  codec: OfflineCacheCodec | null,
  prompts: readonly StoredPrompt[]
): void {
  if (!codec) {
    return
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, codec.encrypt(JSON.stringify({ version: 2, prompts })), { mode: 0o600 })
  renameSync(temp, path)
}

/** The first build kept the queue as plaintext JSON beside the sealed file; it is never read. */
export function removeLegacyPlaintextQueue(path: string): void {
  rmSync(join(dirname(path), 'orca-cloud-queued-prompts.json'), { force: true })
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
  const result = response.result as { ok: boolean; page?: { fence?: number }; fence?: number }
  const fence = result.page?.fence ?? (result.ok ? undefined : result.fence)
  return typeof fence === 'number' ? fence : null
}

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
}
