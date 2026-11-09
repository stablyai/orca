// Wake on message: a prompt sent to an agent chat in a sleeping Orca Cloud workspace waits here
// (sealed on disk, so it survives an app restart), wakes the VM, and is delivered once orcad
// answers.
//
// At most once: a prompt's clientOperationId is fixed from the moment it is marked `sending` (on
// disk, before the send); a retry after a crash or lost reply reuses it, and the host returns its
// recorded outcome instead of sending twice. Ids are host-admissible (timestamped) and re-minted
// only while the prompt was never sent, before they age past the host's admission window.
//
// Only the person queuing a prompt wakes a VM. Background retries deliver only to a VM that is
// already up, never to one asleep, archived or manually disconnected, and stop after a budget.
import { randomUUID } from 'node:crypto'
import { CLOUD_QUEUED_PROMPT_MAX_CHARS } from '../../shared/hosted-sandbox/cloud-workspace-offline-api'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { structuredAgentSessionMessageSendMutation } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  parseAgentSessionOperationTimestamp
} from '../../shared/agent-session/agent-session-host-authority'
import { createStructuredAgentSessionOperationId } from '../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { SendParams } from '../../shared/rpc-contract/structured-agent-session-params'
import {
  createSealedPromptDisk,
  currentFence,
  earliestOwedAttempt,
  publicView,
  RETRYABLE_REFUSALS,
  SendResultSchema,
  type CloudMessageQueue,
  type CloudMessageQueueDeps,
  type StoredPrompt
} from './cloud-message-queue-store'

/** Delivered prompts stay listed briefly so the chat can show "Delivered". */
const DELIVERED_RETENTION_MS = 10 * 60_000
export const MAX_FAILURES = 6
const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 15 * 60_000
const SEND_TIMEOUT_MS = 60_000
/** Re-mint a never-sent id this long before the host would refuse it as expired. */
const REMINT_MARGIN_MS = 60 * 60_000

export type {
  CloudMessageQueue,
  CloudMessageQueueDeps,
  WorkspaceAvailability
} from './cloud-message-queue-store'

export function createCloudMessageQueue(deps: CloudMessageQueueDeps): CloudMessageQueue {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.error(line))
  const driving = new Map<string, Promise<void>>()
  const mintId = () => createStructuredAgentSessionOperationId(randomUUID, now())
  let prompts: StoredPrompt[] = []
  // Bumped by clear() so a load still reading the old file cannot bring cleared prompts back.
  let generation = 0
  const disk = createSealedPromptDisk(deps.path, deps.codec, log)
  const loaded = disk.load.then((stored) => {
    prompts = generation === 0 ? [...stored, ...prompts] : prompts
  })

  /** Resolves once the queue is on disk as of this call; rejects if that write failed. */
  function save(): Promise<void> {
    const cutoff = now() - DELIVERED_RETENTION_MS
    prompts = prompts.filter((prompt) => prompt.state !== 'delivered' || prompt.updatedAt >= cutoff)
    return disk.write(prompts)
  }

  function update(prompt: StoredPrompt, patch: Partial<StoredPrompt>): Promise<void> {
    Object.assign(prompt, patch, { updatedAt: now() })
    const saved = save()
    deps.onChange?.(prompt.workspaceId)
    return saved
  }

  function failOnce(prompt: StoredPrompt, error: string): void {
    const failures = prompt.failures + 1
    if (failures >= MAX_FAILURES) {
      // A prompt that reached `sending` may already be on the host: say so, so nobody re-sends it.
      void update(
        prompt,
        prompt.state === 'sending'
          ? {
              failures,
              state: 'unconfirmed',
              error: 'Delivery could not be confirmed. Check the chat before sending again.'
            }
          : { failures, state: 'failed', error }
      )
      return
    }
    void update(prompt, {
      failures,
      nextAttemptAt: now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1))
    })
  }

  const pendingOf = (workspaceId: string) =>
    prompts
      .filter(
        (p) => p.workspaceId === workspaceId && (p.state === 'queued' || p.state === 'sending')
      )
      .sort((a, b) => a.createdAt - b.createdAt)

  /** One attempt. 'stop': leave the rest of this workspace for later. */
  async function deliver(prompt: StoredPrompt, environmentId: string): Promise<'next' | 'stop'> {
    // A never-sent id close to the host's admission window gets a fresh one; a sent one never does.
    const mintedAt = parseAgentSessionOperationTimestamp(prompt.clientOperationId) ?? 0
    if (
      prompt.state === 'queued' &&
      now() - mintedAt > AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS - REMINT_MARGIN_MS
    ) {
      await update(prompt, { clientOperationId: mintId() })
    }
    const before = { id: prompt.clientOperationId, text: prompt.text, state: prompt.state }
    let fence: number | { refused: string } | null
    try {
      fence = await currentFence(deps.call, environmentId, prompt.sessionId)
    } catch (error) {
      failOnce(prompt, `Could not reach the workspace: ${String(error).slice(0, 120)}`)
      return 'stop'
    }
    // Cancelled or edited while the fence was read: this attempt is void (the loop re-reads).
    if (
      !prompts.includes(prompt) ||
      prompt.clientOperationId !== before.id ||
      prompt.text !== before.text ||
      // A Sleep or archive failed it meanwhile (the person may already have re-sent it).
      prompt.state !== before.state
    ) {
      return 'next'
    }
    if (fence === null) {
      failOnce(prompt, 'The chat did not answer.')
      return 'stop'
    }
    if (typeof fence !== 'number') {
      await update(prompt, { state: 'failed', error: 'This chat is no longer on the workspace.' })
      return 'next'
    }
    const params = structuredAgentSessionMessageSendMutation({
      sessionId: prompt.sessionId,
      clientOperationId: prompt.clientOperationId,
      expectedRuntimeFence: fence,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: prompt.text }] },
      // A busy agent queues it behind its current turn instead of refusing.
      delivery: 'queue-if-active'
    })
    // The host's own schema: a prompt it would reject outright is failed here, never retried.
    if (!SendParams.safeParse(params).success) {
      await update(prompt, { state: 'failed', error: 'This message cannot be sent to that chat.' })
      return 'next'
    }
    // Durable before the send: from here on, any retry resends this same operation id.
    await update(prompt, { state: 'sending' })
    let response: RuntimeRpcResponse<unknown>
    try {
      response = await deps.call(environmentId, 'agentSession.send', params, SEND_TIMEOUT_MS)
    } catch (error) {
      log(`[orca-cloud] queued prompt send unconfirmed, will retry: ${String(error)}`)
      failOnce(prompt, 'Delivery was not confirmed.')
      return 'stop'
    }
    if (!response.ok) {
      failOnce(prompt, response.error.message.slice(0, 200))
      return 'stop'
    }
    const parsed = SendResultSchema.safeParse(response.result)
    const result = parsed.success ? parsed.data : { ok: false, refusal: undefined }
    if (result.ok) {
      await update(prompt, { state: 'delivered', error: undefined })
      return 'next'
    }
    const code = result.refusal?.code ?? 'unknown'
    if (RETRYABLE_REFUSALS.has(code)) {
      failOnce(prompt, result.refusal?.message ?? code)
      return 'stop'
    }
    await update(prompt, { state: 'failed', error: result.refusal?.message ?? code })
    return 'next'
  }

  async function driveWorkspace(workspaceId: string, allowWake: boolean): Promise<void> {
    await loaded
    if (pendingOf(workspaceId).length === 0) {
      return
    }
    let place = await deps.locate(workspaceId)
    if (place.kind === 'gone') {
      queue.failPending(workspaceId, 'The workspace was removed.')
      return
    }
    if (place.kind === 'blocked') {
      return
    }
    if (place.kind === 'asleep') {
      if (!allowWake) {
        return
      }
      if (!(await deps.wake(workspaceId))) {
        for (const prompt of pendingOf(workspaceId)) {
          failOnce(prompt, 'The workspace did not wake.')
        }
        return
      }
      place = await deps.locate(workspaceId)
      if (place.kind !== 'up') {
        return
      }
    }
    // Re-read each turn: prompts can be cancelled, edited or added while one is delivered.
    for (;;) {
      const next = pendingOf(workspaceId).find((p) => allowWake || p.nextAttemptAt <= now())
      // In order: a prompt never overtakes an earlier one that is still pending.
      if (!next || next !== pendingOf(workspaceId)[0]) {
        return
      }
      if ((await deliver(next, place.environmentId)) === 'stop') {
        return
      }
    }
  }

  function run(workspaceId: string, allowWake: boolean): Promise<void> {
    const running = driving.get(workspaceId)
    if (running) {
      return allowWake ? running.then(() => run(workspaceId, true)) : running
    }
    const work = driveWorkspace(workspaceId, allowWake)
      .catch((error: unknown) =>
        log(`[orca-cloud] queued prompt delivery failed: ${String(error)}`)
      )
      .finally(() => driving.delete(workspaceId))
    driving.set(workspaceId, work)
    return work
  }

  const queue: CloudMessageQueue = {
    async enqueue({ workspaceId, sessionId, text }) {
      const trimmed = text.trim()
      if (!trimmed || trimmed.length > CLOUD_QUEUED_PROMPT_MAX_CHARS) {
        throw new Error('Prompt is empty or too long.')
      }
      await loaded
      const place = await deps.locate(workspaceId)
      if (place.kind === 'blocked') {
        throw new Error(place.reason)
      }
      if (place.kind === 'gone') {
        throw new Error('Not an Orca Cloud workspace.')
      }
      const at = now()
      const prompt: StoredPrompt = {
        id: randomUUID(),
        clientOperationId: mintId(),
        workspaceId,
        sessionId,
        text: trimmed,
        state: 'queued',
        createdAt: at,
        updatedAt: at,
        failures: 0,
        nextAttemptAt: at
      }
      prompts.push(prompt)
      await save()
      deps.onChange?.(workspaceId)
      void run(workspaceId, true)
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
      void save()
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
      void update(prompt, { text: trimmed, clientOperationId: mintId() })
      return true
    },
    nextAttemptAt: () => earliestOwedAttempt(prompts),
    flushed: () => disk.flushed(),
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
      return Promise.all(ids.map((id) => run(id, false))).then(() => undefined)
    },
    failPending(workspaceId, reason) {
      let changed = false
      for (const prompt of prompts) {
        // `sending` stays: it may already be on the host; the next pass to an awake VM settles it.
        if (prompt.workspaceId === workspaceId && prompt.state === 'queued') {
          Object.assign(prompt, { state: 'failed', error: reason, updatedAt: now() })
          changed = true
        }
      }
      if (changed) {
        void save()
        deps.onChange?.(workspaceId)
      }
    },
    clear() {
      generation++
      const workspaces = new Set(prompts.map((p) => p.workspaceId))
      prompts = []
      void disk.remove().catch(() => undefined)
      for (const workspaceId of workspaces) {
        deps.onChange?.(workspaceId)
      }
    }
  }
  return queue
}
