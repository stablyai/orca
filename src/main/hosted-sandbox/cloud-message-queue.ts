// Wake on message: a prompt sent to an agent chat in a sleeping Orca Cloud workspace waits here
// (on disk, so it survives an app restart), wakes the VM, and is delivered once orcad answers.
// At most once: each prompt has one clientOperationId for its whole life and is marked `sending`
// on disk before the send; a retry after a crash or lost reply reuses the id, and the host
// returns its recorded outcome instead of sending twice.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  CLOUD_QUEUED_PROMPT_MAX_CHARS,
  type CloudQueuedPrompt
} from '../../shared/hosted-sandbox/cloud-workspace-offline-api'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { structuredAgentSessionMessageSendMutation } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'

type StoredPrompt = CloudQueuedPrompt & { clientOperationId: string; attempts: number }

/** Refusals that mean "not now", not "never": the same operation is sent again. */
const RETRYABLE_REFUSALS = new Set([
  'agent_session_checkpoint_stale',
  'execution_owner_reconciling',
  'agent_session_ownership_unknown',
  'agent_session_operation_capacity'
])
/** Delivered prompts stay listed briefly so the chat can show "Delivered". */
const DELIVERED_RETENTION_MS = 10 * 60_000
const MAX_ATTEMPTS = 8
const SEND_TIMEOUT_MS = 60_000

export type CloudMessageQueueDeps = {
  path: string
  now?: () => number
  /** The workspace's environment and whether its VM is asleep; null when it is not a cloud workspace. */
  locate: (workspaceId: string) => { environmentId: string; asleep: boolean } | null
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
  enqueue(args: { workspaceId: string; sessionId: string; text: string }): CloudQueuedPrompt
  list(workspaceId: string): CloudQueuedPrompt[]
  cancel(id: string): boolean
  edit(id: string, text: string): boolean
  /** Deliver everything pending for one workspace (or all); single-flight per workspace. */
  drive(workspaceId?: string): Promise<void>
}

function publicView(prompt: StoredPrompt): CloudQueuedPrompt {
  const { clientOperationId: _id, attempts: _attempts, ...view } = prompt
  return view
}

export function createCloudMessageQueue(deps: CloudMessageQueueDeps): CloudMessageQueue {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.error(line))
  const driving = new Map<string, Promise<void>>()
  let prompts: StoredPrompt[] = load()

  function load(): StoredPrompt[] {
    try {
      const parsed = JSON.parse(readFileSync(deps.path, 'utf8')) as {
        version: 1
        prompts: StoredPrompt[]
      }
      return parsed.version === 1 && Array.isArray(parsed.prompts) ? parsed.prompts : []
    } catch {
      return []
    }
  }

  function save(): void {
    const cutoff = now() - DELIVERED_RETENTION_MS
    prompts = prompts.filter((prompt) => prompt.state !== 'delivered' || prompt.updatedAt >= cutoff)
    mkdirSync(dirname(deps.path), { recursive: true, mode: 0o700 })
    const temp = `${deps.path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, prompts }), { mode: 0o600 })
    renameSync(temp, deps.path)
  }

  function update(prompt: StoredPrompt, patch: Partial<StoredPrompt>): void {
    Object.assign(prompt, patch, { updatedAt: now() })
    save()
    deps.onChange?.(prompt.workspaceId)
  }

  /** The session's fence; `refused` when the host says the chat is gone; null to retry later. */
  async function currentFence(
    environmentId: string,
    sessionId: string
  ): Promise<number | { refused: string } | null> {
    const response = await deps.call(
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

  /** One attempt; returns false when the workspace should be retried later. */
  async function deliver(prompt: StoredPrompt, environmentId: string): Promise<boolean> {
    let fence: number | { refused: string } | null
    try {
      fence = await currentFence(environmentId, prompt.sessionId)
    } catch {
      return false
    }
    if (fence === null) {
      return false
    }
    if (typeof fence !== 'number') {
      update(prompt, { state: 'failed', error: 'This chat is no longer on the workspace.' })
      return true
    }
    // Durable before the send: a crash from here on resends this same operation id.
    update(prompt, { state: 'sending', attempts: prompt.attempts + 1 })
    const params = structuredAgentSessionMessageSendMutation({
      sessionId: prompt.sessionId,
      clientOperationId: prompt.clientOperationId,
      expectedRuntimeFence: fence,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: prompt.text }] },
      // A busy agent queues it behind its current turn instead of refusing.
      delivery: 'queue-if-active'
    })
    let response: RuntimeRpcResponse<unknown>
    try {
      response = await deps.call(environmentId, 'agentSession.send', params, SEND_TIMEOUT_MS)
    } catch (error) {
      log(`[orca-cloud] queued prompt send unconfirmed, will retry: ${String(error)}`)
      return false
    }
    if (!response.ok) {
      // Transport-level: the host never answered for this operation; the retry reuses its id.
      return false
    }
    const result = response.result as { ok: boolean; refusal?: { code?: string; message?: string } }
    if (result.ok) {
      update(prompt, { state: 'delivered', error: undefined })
      return true
    }
    const code = result.refusal?.code ?? 'unknown'
    if (RETRYABLE_REFUSALS.has(code) && prompt.attempts < MAX_ATTEMPTS) {
      return false
    }
    update(prompt, { state: 'failed', error: result.refusal?.message ?? code })
    return true
  }

  async function driveWorkspace(workspaceId: string): Promise<void> {
    const pending = () =>
      prompts
        .filter(
          (p) => p.workspaceId === workspaceId && (p.state === 'queued' || p.state === 'sending')
        )
        .sort((a, b) => a.createdAt - b.createdAt)
    if (pending().length === 0) {
      return
    }
    const located = deps.locate(workspaceId)
    if (!located) {
      return
    }
    if (located.asleep && !(await deps.wake(workspaceId))) {
      return
    }
    for (const prompt of pending()) {
      if (prompt.attempts >= MAX_ATTEMPTS) {
        update(prompt, { state: 'failed', error: 'Could not deliver after several tries.' })
        continue
      }
      // In order: a later prompt never overtakes one that is not yet delivered.
      if (!(await deliver(prompt, located.environmentId))) {
        return
      }
    }
  }

  return {
    enqueue({ workspaceId, sessionId, text }) {
      const trimmed = text.trim()
      if (!trimmed || trimmed.length > CLOUD_QUEUED_PROMPT_MAX_CHARS) {
        throw new Error('Prompt is empty or too long.')
      }
      const at = now()
      const prompt: StoredPrompt = {
        id: randomUUID(),
        clientOperationId: randomUUID(),
        workspaceId,
        sessionId,
        text: trimmed,
        state: 'queued',
        createdAt: at,
        updatedAt: at,
        attempts: 0
      }
      prompts.push(prompt)
      save()
      deps.onChange?.(workspaceId)
      return publicView(prompt)
    },
    list(workspaceId) {
      return prompts.filter((p) => p.workspaceId === workspaceId).map(publicView)
    },
    cancel(id) {
      const prompt = prompts.find((p) => p.id === id)
      if (!prompt || prompt.state !== 'queued') {
        return false
      }
      prompts = prompts.filter((p) => p !== prompt)
      save()
      deps.onChange?.(prompt.workspaceId)
      return true
    },
    edit(id, text) {
      const prompt = prompts.find((p) => p.id === id)
      const trimmed = text.trim()
      if (
        !prompt ||
        prompt.state !== 'queued' ||
        !trimmed ||
        trimmed.length > CLOUD_QUEUED_PROMPT_MAX_CHARS
      ) {
        return false
      }
      // Never sent, so a new text is a new operation; nothing on the host knows the old id.
      update(prompt, { text: trimmed, clientOperationId: randomUUID() })
      return true
    },
    drive(workspaceId) {
      const ids = workspaceId
        ? [workspaceId]
        : [
            ...new Set(
              prompts
                .filter((p) => p.state === 'queued' || p.state === 'sending')
                .map((p) => p.workspaceId)
            )
          ]
      return Promise.all(
        ids.map((id) => {
          const running = driving.get(id)
          if (running) {
            return running
          }
          const run = driveWorkspace(id)
            .catch((error: unknown) =>
              log(`[orca-cloud] queued prompt delivery failed: ${String(error)}`)
            )
            .finally(() => driving.delete(id))
          driving.set(id, run)
          return run
        })
      ).then(() => undefined)
    }
  }
}
