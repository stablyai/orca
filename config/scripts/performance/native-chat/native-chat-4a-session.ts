// Chat operations through the host RPC surface both arms serve, with envelopes built by each arm's own protocol bundle.
// Its AppStore import also declares the window.__store and window.api globals these page.evaluate callbacks use.
import type { AppStore } from '../../../../tests/e2e/helpers/runtime-types'
import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { operationId, type Arm } from './native-chat-4a-arm'
import { rendererTime, rpc, visibleChatState } from './native-chat-4a-probes'

type HistoryItem = {
  itemId: string
  body?: {
    kind?: string
    role?: string
    state?: string
    callId?: string
    output?: { byteLength?: number }
  }
}
export type HistoryPage = {
  epoch: string
  fence?: number
  items: HistoryItem[]
  window: { nextCursor: unknown }
  hasOlder: boolean
  queuedMessages?: { messageId: string; body: unknown; state: string }[] | null
}
type HistoryResult = { ok: boolean; page: HistoryPage; fence?: number }

export async function history(
  page: Page,
  sessionId: string,
  direction: 'tail' | 'before' | 'after',
  limit: number,
  cursor?: unknown
) {
  const answer = await rpc<HistoryResult>(page, 'agentSession.history', {
    sessionId,
    direction,
    limit,
    ...(cursor ? { cursor } : {})
  })
  return { ...answer, page: answer.value.page }
}

async function currentFence(page: Page, sessionId: string): Promise<number> {
  const { value } = await rpc<HistoryResult>(page, 'agentSession.history', {
    sessionId,
    direction: 'tail',
    limit: 1
  })
  const fence = value.page.fence ?? value.fence
  if (typeof fence !== 'number') {
    throw new Error(`${sessionId}: history served no runtime fence`)
  }
  return fence
}

export async function createChat(
  page: Page,
  arm: Arm,
  worktreeId: string,
  forkFrom?: { sessionId: string; throughItemId: string }
) {
  const sessionId = arm.protocol.createStructuredAgentSessionId('claude', randomUUID)
  const worktree = `id:${worktreeId}`
  const params = {
    envelope: {
      sessionId,
      clientOperationId: operationId(arm),
      expectedRuntimeFence: null,
      payloadFingerprint: arm.protocol.structuredAgentSessionCreateFingerprint({
        sessionId,
        worktree,
        agent: 'claude',
        forkFrom
      })
    },
    worktree,
    agent: 'claude',
    ...(forkFrom ? { forkFrom } : {})
  }
  const answer = await rpc(page, 'agentSession.create', params)
  return { sessionId, hostMs: answer.hostMs, startedAt: answer.startedAt }
}

/** The renderer's generic write: fingerprint {method, sessionId, fields} at the fence the client last saw. */
export async function mutate<T = unknown>(
  page: Page,
  arm: Arm,
  method: string,
  sessionId: string,
  fields: Record<string, unknown>,
  beforeRequest?: () => void
) {
  const envelope = {
    sessionId,
    clientOperationId: operationId(arm),
    expectedRuntimeFence: await currentFence(page, sessionId),
    payloadFingerprint: arm.protocol.structuredAgentSessionPayloadFingerprint({
      method,
      sessionId,
      fields
    })
  }
  beforeRequest?.()
  return rpc<T>(page, method, { envelope, ...fields })
}

export async function send(
  page: Page,
  arm: Arm,
  sessionId: string,
  text: string,
  queueIfActive = true,
  beforeRequest?: () => void
) {
  const params = arm.protocol.structuredAgentSessionMessageSendMutation({
    sessionId,
    clientOperationId: operationId(arm),
    expectedRuntimeFence: await currentFence(page, sessionId),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    ...(queueIfActive ? { delivery: 'queue-if-active' as const } : {})
  })
  beforeRequest?.()
  return rpc<{ ok?: boolean; queued?: unknown }>(page, 'agentSession.send', params)
}

/** Poll the durable tail until it holds `marker`: the reply was committed and is readable, independent of any view. */
export async function waitForDurable(
  page: Page,
  sessionId: string,
  marker: string,
  timeoutMs = 120_000,
  everyMs = 25
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tail = await history(page, sessionId, 'tail', 3)
    if (JSON.stringify(tail.page.items).includes(marker)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
  throw new Error(`${sessionId}: ${marker} was not durable within ${timeoutMs} ms`)
}

/** Settled when no turn row in the tail is still running and nothing is queued. */
export async function waitForIdle(page: Page, sessionId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tail = await history(page, sessionId, 'tail', 20)
    const running = tail.page.items.some(
      (item) => item.body?.kind === 'turn' && item.body.state === 'running'
    )
    if (!running && (tail.page.queuedMessages ?? []).length === 0) {
      return tail.page
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`${sessionId}: still active after ${timeoutMs} ms`)
}

/** Message item ids of one role, oldest first: rewind cuts at a user prompt, fork copies through a response. */
export async function messageItemIds(
  page: Page,
  sessionId: string,
  role: 'user' | 'assistant',
  limit = 200
): Promise<string[]> {
  const ids: string[] = []
  let cursor: unknown
  for (;;) {
    const read = await history(page, sessionId, cursor ? 'before' : 'tail', 200, cursor)
    ids.unshift(
      ...read.page.items
        .filter((item) => item.body?.kind === 'message' && item.body.role === role)
        .map((item) => item.itemId)
    )
    if (!read.page.hasOlder || ids.length >= limit) {
      return ids.slice(-limit)
    }
    cursor = read.page.window.nextCursor
  }
}

/** Activate the chat's tab through the tab bar, the way a user switches chats; never reveals or focuses the window. */
export async function openChatTab(
  page: Page,
  worktreeId: string,
  sessionId: string
): Promise<void> {
  const tabId = await page.waitForFunction(
    ({ worktreeId, sessionId }) =>
      window.__store
        ?.getState()
        .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === sessionId)?.id ?? false,
    { worktreeId, sessionId },
    { timeout: 60_000 }
  )
  const id = await tabId.jsonValue()
  if (typeof id !== 'string') {
    throw new Error(`${sessionId}: no tab id for the chat`)
  }
  // Unified chat tabs activate through their group; a worktree switch can restore another tab first, so re-apply until it holds.
  await page.waitForFunction(
    ({ worktreeId, id }) => {
      const store: AppStore = window.__store!
      const state = store.getState()
      const group = (state.groupsByWorktree[worktreeId] ?? []).find((candidate) =>
        candidate.tabOrder.includes(id)
      )
      if (state.activeWorktreeId === worktreeId && group?.activeTabId === id) {
        return true
      }
      if (state.activeWorktreeId !== worktreeId) {
        state.setActiveWorktree(worktreeId)
      }
      store.getState().activateTab(id, { worktreeId })
      return false
    },
    { worktreeId, id },
    { timeout: 30_000, polling: 100 }
  )
}

/** Controls known: the composer is interactive and the working flag has been published for this chat. */
export async function waitForControls(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const root = [...document.querySelectorAll('[data-native-chat-root="true"]')].find(
        (candidate) => candidate.checkVisibility()
      )
      const composer = root?.querySelector('[role="textbox"]')
      // The working flag is an attribute of the root itself.
      return Boolean(
        composer instanceof HTMLElement &&
        composer.isContentEditable &&
        composer.getAttribute('aria-disabled') !== 'true' &&
        !composer.hasAttribute('disabled') &&
        root?.hasAttribute('data-native-chat-working')
      )
    },
    null,
    { timeout: timeoutMs, polling: 16 }
  )
}

export async function waitForWorking(
  page: Page,
  working: boolean,
  timeoutMs = 120_000
): Promise<number> {
  const handle = await page
    .waitForFunction(
      (working) => {
        const root = [...document.querySelectorAll('[data-native-chat-root="true"]')].find(
          (candidate) => candidate.checkVisibility()
        )
        return root?.getAttribute('data-native-chat-working') === String(working)
          ? performance.now()
          : false
      },
      working,
      { timeout: timeoutMs, polling: 16 }
    )
    .catch(async (error: unknown) => {
      throw new Error(
        `working=${working} not shown in ${timeoutMs} ms (${await visibleChatState(page)})`,
        {
          cause: error
        }
      )
    })
  return rendererTime(handle)
}
