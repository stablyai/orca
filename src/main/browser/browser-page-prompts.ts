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

// New tabs may prompt before registration; a null target means no local window.
export type BrowserPagePromptTarget =
  | { browserPageId: string; renderer: Electron.WebContents }
  | 'awaiting-registration'

type SettlePrompt<A> = (answer: A | null) => void | 'failed' | Promise<void | 'failed'>

type PendingPrompt = {
  kind: BrowserPagePromptKind
  coalesceKey: string | undefined
  requester: Electron.WebContents
  /** Null until the tab registers its window. */
  browserPageId: string | null
  renderer: Electron.WebContents | null
  details: () => unknown
  parseAnswer: (value: unknown) => unknown
  settles: ((value: unknown) => ReturnType<SettlePrompt<unknown>>)[]
  timer: ReturnType<typeof setTimeout> | undefined
  unwatch: (() => void)[]
}

/** Only prompting schedules settle; refused and no-window leave settlement to the caller. */
export type BrowserPagePromptOpening = 'prompting' | 'refused' | 'no-window'

const pendingPrompts = new Map<string, PendingPrompt>()

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

// Requests share a prompt only when requester, kind and an explicit coalescing key match.
export function openBrowserPagePrompt<K extends BrowserPagePromptKind>(args: {
  kind: K
  requester: Electron.WebContents
  target: BrowserPagePromptTarget | null
  details: () => BrowserPagePromptDetails<K>
  coalesceKey?: string
  /** For the page's own dialogs: no timeout, and asked even when other prompts are open or quieted. */
  waitsForAnswer?: boolean
  parseAnswer: (value: unknown) => BrowserPagePromptAnswer<K> | undefined
  settle: SettlePrompt<BrowserPagePromptAnswer<K>>
}): BrowserPagePromptOpening {
  const { requester, target } = args
  if (!target || requester.isDestroyed()) {
    return 'no-window'
  }
  const context = target === 'awaiting-registration' ? null : target
  if (context?.renderer.isDestroyed()) {
    return 'no-window'
  }
  if (!args.waitsForAnswer && isBrowserPagePromptQuiet(requester)) {
    return 'refused'
  }
  if (!args.waitsForAnswer) {
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
    timer: args.waitsForAnswer
      ? undefined
      : setTimeout(() => closePrompt(requestId, true), BROWSER_PAGE_PROMPT_TIMEOUT_MS),
    unwatch: [closeWhenGone(requestId, requester, { orNavigates: true })]
  }
  pendingPrompts.set(requestId, pending)
  if (context && !showPrompt(requestId, pending, context)) {
    takePending(requestId)
    return 'no-window'
  }
  return 'prompting'
}

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

/** Closes a page's prompts of one kind that were answered some other way. */
export function closeBrowserPagePrompts(
  requester: Electron.WebContents,
  kind: BrowserPagePromptKind
): void {
  for (const [requestId, pending] of pendingPrompts) {
    if (pending.requester === requester && pending.kind === kind) {
      closePrompt(requestId, false)
    }
  }
}

export function cancelBrowserPagePrompts(browserPageId: string): void {
  for (const [requestId, pending] of pendingPrompts) {
    if (pending.browserPageId === browserPageId) {
      closePrompt(requestId, false)
    }
  }
}
