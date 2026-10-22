import { randomUUID } from 'node:crypto'

import type {
  BrowserPagePromptAnswer,
  BrowserPagePromptDetails,
  BrowserPagePromptKind,
  BrowserPagePromptResponse,
  BrowserPagePromptResult
} from '../../shared/browser-page-prompt'
import { isBrowserPagePromptQuiet, quietBrowserPagePrompts } from './browser-page-prompt-quiet'

export const BROWSER_PAGE_PROMPT_TIMEOUT_MS = 120_000

/**
 * Where a page's prompt shows: the window showing its tab, or nowhere yet because a new tab started
 * loading before its window registered it. Null: no window on this machine (e.g. streamed from a
 * server).
 */
export type BrowserPagePromptTarget =
  | { browserPageId: string; renderer: Electron.WebContents }
  | 'awaiting-registration'

/** Runs once per request: with the user's answer, or null when declined, expired or the page left. */
type SettlePrompt<A> = (answer: A | null) => void | 'failed' | Promise<void | 'failed'>

type PendingPrompt = {
  kind: BrowserPagePromptKind
  coalesceKey: string | undefined
  requester: Electron.WebContents
  /** Null while a new tab's window has not registered it yet; the prompt shows once it does. */
  browserPageId: string | null
  renderer: Electron.WebContents | null
  details: () => unknown
  /** Undefined when the window's reply is not a valid answer for this kind. */
  parseAnswer: (value: unknown) => unknown
  /** One per waiting request; each reads the validated reply with its own kind's parser. */
  settles: ((value: unknown) => ReturnType<SettlePrompt<unknown>>)[]
  timer: ReturnType<typeof setTimeout>
  unwatch: (() => void)[]
}

/**
 * `prompting`: the window is asking, or will once it registers the tab, and settle will run.
 * `refused`: the page is quiet or already prompting. `no-window`: the page has no window on this
 * machine (e.g. streamed from a server). Settle never runs for the last two.
 */
export type BrowserPagePromptOpening = 'prompting' | 'refused' | 'no-window'

const pendingPrompts = new Map<string, PendingPrompt>()

/** The site a prompt names; null for opaque or unparseable pages. */
export function browserPagePromptOrigin(rawUrl: string | null): string | null {
  if (!rawUrl) {
    return null
  }
  try {
    const { origin } = new URL(rawUrl)
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

function takePending(requestId: string): PendingPrompt | null {
  const pending = pendingPrompts.get(requestId)
  if (!pending) {
    return null
  }
  clearTimeout(pending.timer)
  for (const unwatch of pending.unwatch) {
    unwatch()
  }
  pendingPrompts.delete(requestId)
  return pending
}

function bindSettle<A>(
  parseAnswer: (value: unknown) => A | undefined,
  settle: SettlePrompt<A>
): PendingPrompt['settles'][number] {
  return (value) => settle(value === null ? null : (parseAnswer(value) ?? null))
}

async function runSettles(pending: PendingPrompt, answer: unknown): Promise<'answered' | 'failed'> {
  const results = await Promise.all(
    pending.settles.map(async (settle) => {
      try {
        return await settle(answer)
      } catch (error) {
        console.warn(`[browser] ${pending.kind} prompt answer failed:`, error)
        return 'failed'
      }
    })
  )
  return results.includes('failed') ? 'failed' : 'answered'
}

/** Dismisses the prompt on screen and answers every waiting request with null. */
function closePrompt(requestId: string, quiet: boolean): void {
  const pending = takePending(requestId)
  if (!pending) {
    return
  }
  try {
    if (pending.renderer && !pending.renderer.isDestroyed()) {
      pending.renderer.send('browser:page-prompt-closed', { requestId })
    }
  } catch {
    // Renderer may be destroyed between the check and send.
  }
  if (quiet) {
    quietBrowserPagePrompts(pending.requester)
  }
  void runSettles(pending, null)
}

/** Closes the prompt when `contents` closes or crashes, or optionally commits a new document. */
function closeWhenGone(
  requestId: string,
  contents: Electron.WebContents,
  { orNavigates }: { orNavigates: boolean }
): () => void {
  const close = (): void => closePrompt(requestId, false)
  contents.on('destroyed', close)
  contents.on('render-process-gone', close)
  if (orNavigates) {
    contents.on('did-navigate', close)
  }
  return () => {
    try {
      contents.off('destroyed', close)
      contents.off('render-process-gone', close)
      contents.off('did-navigate', close)
    } catch {
      // Contents may already be destroyed.
    }
  }
}

function showPrompt(
  requestId: string,
  pending: PendingPrompt,
  context: { browserPageId: string; renderer: Electron.WebContents }
): boolean {
  pending.browserPageId = context.browserPageId
  pending.renderer = context.renderer
  // Why: no window is left to answer once the one that was asked closes or crashes.
  pending.unwatch.push(closeWhenGone(requestId, context.renderer, { orNavigates: false }))
  try {
    context.renderer.send('browser:page-prompt-requested', {
      requestId,
      kind: pending.kind,
      details: pending.details()
    })
    return true
  } catch {
    return false
  }
}

/**
 * Asks the window showing the page or popup `requester` belongs to. One prompt per page: a request
 * from the same contents, with the same kind and `coalesceKey` as the open one, shares its answer;
 * any other is refused.
 */
export function openBrowserPagePrompt<K extends BrowserPagePromptKind>(args: {
  kind: K
  requester: Electron.WebContents
  target: BrowserPagePromptTarget | null
  /** Built only when a new prompt opens. */
  details: () => BrowserPagePromptDetails<K>
  coalesceKey?: string
  /** Returns the answer when the window's reply is a valid one, else undefined. */
  parseAnswer: (value: unknown) => BrowserPagePromptAnswer<K> | undefined
  settle: SettlePrompt<BrowserPagePromptAnswer<K>>
}): BrowserPagePromptOpening {
  const { requester, target } = args
  if (!target || requester.isDestroyed()) {
    return 'no-window'
  }
  // Why: a new tab starts loading before its window registers it; hold the question until it does.
  const context = target === 'awaiting-registration' ? null : target
  if (context?.renderer.isDestroyed()) {
    return 'no-window'
  }
  if (isBrowserPagePromptQuiet(requester)) {
    return 'refused'
  }
  for (const pending of pendingPrompts.values()) {
    const samePage =
      pending.requester.id === requester.id ||
      (context !== null && pending.browserPageId === context.browserPageId)
    if (!samePage) {
      continue
    }
    if (
      args.coalesceKey !== undefined &&
      pending.requester.id === requester.id &&
      pending.kind === args.kind &&
      pending.coalesceKey === args.coalesceKey
    ) {
      pending.settles.push(bindSettle(args.parseAnswer, args.settle))
      return 'prompting'
    }
    return 'refused'
  }
  const requestId = randomUUID()
  const pending: PendingPrompt = {
    kind: args.kind,
    coalesceKey: args.coalesceKey,
    requester,
    browserPageId: null,
    renderer: null,
    details: args.details,
    parseAnswer: args.parseAnswer,
    settles: [bindSettle(args.parseAnswer, args.settle)],
    timer: setTimeout(() => closePrompt(requestId, true), BROWSER_PAGE_PROMPT_TIMEOUT_MS),
    // Why: a request whose page closed, crashed or was replaced by a new document no longer stands.
    unwatch: [closeWhenGone(requestId, requester, { orNavigates: true })]
  }
  pendingPrompts.set(requestId, pending)
  if (context && !showPrompt(requestId, pending, context)) {
    takePending(requestId)
    return 'no-window'
  }
  return 'prompting'
}

/** Shows what a new tab asked before its window registered it. */
export function showBrowserPagePromptsAwaitingRegistration(
  guestWebContentsId: number,
  context: { browserPageId: string; renderer: Electron.WebContents } | null
): void {
  for (const [requestId, pending] of pendingPrompts) {
    if (pending.renderer || pending.requester.id !== guestWebContentsId) {
      continue
    }
    if (!context || context.renderer.isDestroyed() || !showPrompt(requestId, pending, context)) {
      closePrompt(requestId, false)
    }
  }
}

export async function respondToBrowserPagePrompt(
  sender: Electron.WebContents,
  response: BrowserPagePromptResponse
): Promise<BrowserPagePromptResult> {
  if (!response || typeof response.requestId !== 'string') {
    return 'rejected'
  }
  const pending = pendingPrompts.get(response.requestId)
  if (!pending || pending.renderer?.id !== sender.id) {
    return 'rejected'
  }
  const answer = response.answer === null ? null : pending.parseAnswer(response.answer)
  if (answer === undefined) {
    return 'rejected'
  }
  takePending(response.requestId)
  if (answer === null) {
    quietBrowserPagePrompts(pending.requester)
  }
  return runSettles(pending, response.answer)
}

/** The page is gone, so nothing it asked for may be granted. */
export function cancelBrowserPagePrompts(browserPageId: string): void {
  for (const [requestId, pending] of pendingPrompts) {
    if (pending.browserPageId === browserPageId) {
      closePrompt(requestId, false)
    }
  }
}
