// Codex's report that a Codex UserPromptSubmit hook (the person's, the project's, a plugin's or a
// managed one) blocked a prompt: a `hook/completed` frame inside the turn, before that turn's
// `turn/completed`. Codex records and echoes nothing for a blocked prompt, so the frame is the only
// proof it never reached history; the turn's end settles the sends it never echoed from it. The
// hook's reason is the words it wrote for the person, kept as plain text: never markup, no control
// or bidi characters, bounded.

import type { CodexSession } from './codex-structured-session-state'
import { readCodexThreadId } from './codex-structured-thread-facts'

/** Long enough for a sentence or two of why, in UTF-16 units; the hook's output stays in its logs. */
export const MAX_CODEX_HOOK_REASON_CHARS = 300

// C0 and C1 controls, and every bidi mark, embedding, override and isolate.
const CONTROL_OR_BIDI = new RegExp(
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point.
  '[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]+',
  'g'
)
const ENDS_A_SENTENCE = /[.!?\u2026\u3002\uff01\uff1f\uff0e]$/
const ELLIPSIS = '\u2026'
const WARNING: ReadonlySet<unknown> = new Set(['warning'])
const BLOCK_REASON: ReadonlySet<unknown> = new Set(['feedback', 'stop'])

/** What a turn's blocking hooks said, kept apart until the turn ends: the first message to the
 *  person (`warning`) and the first reason for the block (`feedback` or `stop`). */
export type CodexPromptBlock = { warning?: string; stop?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

/** One line of plain text: control and bidi characters become spaces, and a long one is cut on a
 *  whole code point. */
export function plainCodexHookReason(text: string): string | undefined {
  const plain = text.replace(CONTROL_OR_BIDI, ' ').replace(/\s+/g, ' ').trim()
  if (!plain) {
    return undefined
  }
  if (plain.length <= MAX_CODEX_HOOK_REASON_CHARS) {
    return plain
  }
  let cut = ''
  for (const codePoint of plain) {
    if (cut.length + codePoint.length > MAX_CODEX_HOOK_REASON_CHARS - ELLIPSIS.length) {
      break
    }
    cut += codePoint
  }
  return `${cut.trimEnd()}${ELLIPSIS}`
}

function entryText(entry: Record<string, unknown> | null): string | undefined {
  return typeof entry?.text === 'string' ? plainCodexHookReason(entry.text) : undefined
}

/** The block this frame reports, or null for any other frame. */
export function readCodexPromptBlock(
  method: string,
  params: unknown
): ({ threadId: string; turnId: string } & CodexPromptBlock) | null {
  const root = record(params)
  const run = record(root?.run)
  const threadId = readCodexThreadId(params)
  const turnId = typeof root?.turnId === 'string' && root.turnId ? root.turnId : null
  if (
    method !== 'hook/completed' ||
    !run ||
    run.eventName !== 'userPromptSubmit' ||
    (run.status !== 'blocked' && run.status !== 'stopped') ||
    !threadId ||
    !turnId
  ) {
    return null
  }
  // The hook's message to the person (`warning`), and why it blocked (`feedback` for a `blocked`
  // run, `stop` for a `stopped` one).
  const entries = (Array.isArray(run.entries) ? run.entries : []).map((entry) => record(entry))
  const firstText = (kinds: ReadonlySet<unknown>) =>
    entries
      .filter((entry) => kinds.has(entry?.kind))
      .map(entryText)
      .find((text) => text !== undefined)
  const warning = firstText(WARNING)
  const stop = firstText(BLOCK_REASON)
  return { threadId, turnId, ...(warning ? { warning } : {}), ...(stop ? { stop } : {}) }
}

/** A turn's block as one reason, as Codex shows it: the message to the person, then why. */
export function codexPromptBlockReason(block: CodexPromptBlock): string | undefined {
  const parts = [block.warning, block.stop].filter((part): part is string => part !== undefined)
  return plainCodexHookReason(
    parts
      .map((part, index) =>
        index < parts.length - 1 && !ENDS_A_SENTENCE.test(part) ? `${part}.` : part
      )
      .join(' ')
  )
}

/** Notes the primary thread's turn whose prompt a Codex hook blocked, until that turn ends. */
export function noteCodexPromptBlock(
  session: Pick<CodexSession, 'threadId' | 'dispatchEchoes'>,
  method: string,
  params: unknown
): void {
  const block = readCodexPromptBlock(method, params)
  if (block && block.threadId === session.threadId) {
    const { threadId, turnId, ...said } = block
    session.dispatchEchoes.blockPrompt(threadId, turnId, said)
  }
}
