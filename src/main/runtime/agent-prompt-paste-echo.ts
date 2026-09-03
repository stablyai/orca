import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START
} from '../../shared/agent-prompt-injection'

// Why: Windows TUIs (Codex) redraw their composer per keystroke while ingesting a bracketed
// paste, which can outlast the render gate's hard cap on large prompts. Waiting for the pane
// to actually echo the paste tail (or collapse to a placeholder) before Enter closes that gap
// without changing behavior on hosts/agents that already settle inside the gate.
export const AGENT_PROMPT_ECHO_TIMEOUT_MS_WIN32 = 20_000
export const AGENT_PROMPT_ECHO_TIMEOUT_MS_DEFAULT = 3_000
export const AGENT_PROMPT_ECHO_POLL_INTERVAL_MS = 100
export const AGENT_PROMPT_ECHO_SETTLE_MS = 250

const AGENT_PROMPT_ECHO_PROBE_LENGTH = 24
const AGENT_PROMPT_ECHO_MIN_INNER_LENGTH = 8

// Why: a composer that already collapsed the paste won't repeat the tail text verbatim.
const AGENT_PROMPT_PASTE_PLACEHOLDER_FRAGMENTS = [
  '[Pastedtext',
  '[PastedContent',
  'Pastedcontent'
] as const

function stripAllWhitespace(text: string): string {
  return text.replace(/\s+/g, '')
}

export function getAgentPromptPasteEchoTimeoutMs(platform: NodeJS.Platform): number {
  return platform === 'win32'
    ? AGENT_PROMPT_ECHO_TIMEOUT_MS_WIN32
    : AGENT_PROMPT_ECHO_TIMEOUT_MS_DEFAULT
}

/** Derives the whitespace-collapsed tail of the pasted text to look for on the pane, or `null`
 *  when the prompt is too short for a tail match to be a meaningful signal. */
export function deriveAgentPromptPasteEchoProbe(pastePayload: string): string | null {
  let inner = pastePayload
  if (inner.startsWith(AGENT_PROMPT_BRACKETED_PASTE_START)) {
    inner = inner.slice(AGENT_PROMPT_BRACKETED_PASTE_START.length)
  }
  if (inner.endsWith(AGENT_PROMPT_BRACKETED_PASTE_END)) {
    inner = inner.slice(0, -AGENT_PROMPT_BRACKETED_PASTE_END.length)
  }
  const normalized = stripAllWhitespace(inner)
  if (normalized.length < AGENT_PROMPT_ECHO_MIN_INNER_LENGTH) {
    return null
  }
  return normalized.slice(-AGENT_PROMPT_ECHO_PROBE_LENGTH)
}

/** True once post-paste terminal output contains the literal tail of the pasted text. */
export function isAgentPromptPasteEchoObserved(paneText: string, probe: string): boolean {
  const normalized = stripAllWhitespace(paneText)
  return normalized.includes(probe)
}

/** Collapsed-paste markers are only evidence when their input is scoped to post-paste output. */
export function isAgentPromptPasteEchoPlaceholderObserved(postPasteOutput: string): boolean {
  const normalized = stripAllWhitespace(postPasteOutput)
  return AGENT_PROMPT_PASTE_PLACEHOLDER_FRAGMENTS.some((fragment) => normalized.includes(fragment))
}
