import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START
} from '../../shared/agent-prompt-injection'
import {
  detectTerminalComposerDraft,
  isTerminalComposerAtCursor,
  type TerminalCursorContext
} from '../../shared/terminal-composer-draft'

/**
 * The composer holds text that is not this prompt, or its parked copy changed before Orca could
 * submit it; nothing was written.
 */
export const AGENT_PROMPT_COMPOSER_NOT_EMPTY_ERROR = 'agent_prompt_composer_not_empty'

/**
 * What an agent's composer holds before Orca pastes a prompt into it.
 * - `none`: empty, or no composer Orca recognizes (today's behavior: paste).
 * - `same-prompt`: Orca's own earlier paste of these exact bytes is still parked, e.g. an attempt
 *   whose Enter did not land.
 * - `foreign`: other typed text, which a paste would silently concatenate onto (#15976).
 */
export type AgentPromptComposerResidue = 'none' | 'same-prompt' | 'foreign'

/** Orca's own last paste into this composer; `landed` once the agent's turn start confirmed it. */
export type AgentPromptOwnPaste = { payload: string; landed: boolean }

export function classifyAgentPromptComposerResidue(
  context: TerminalCursorContext | null | undefined,
  pastePayload: string,
  ownPaste?: AgentPromptOwnPaste | null
): AgentPromptComposerResidue {
  const residue = readTypedComposerText(context)
  if (!residue) {
    return 'none'
  }
  if (!ownPaste || residue !== normalizeComposerText(stripPasteFrame(ownPaste.payload))) {
    return 'foreign'
  }
  // Why: the agent already took that prompt; the screen has not yet repainted its emptied composer.
  if (ownPaste.landed) {
    return 'none'
  }
  // Why: the screen drops indentation and line breaks, so only a byte-identical paste is this prompt.
  return ownPaste.payload === pastePayload ? 'same-prompt' : 'foreign'
}

/** Whether the composer was seen no longer showing this paste: emptied, or holding other words. */
export function composerNoLongerShowsAgentPromptPaste(
  context: TerminalCursorContext | null | undefined,
  payload: string
): boolean {
  // Why: a read that cannot see the composer (hidden cursor, cursor elsewhere) proves nothing.
  if (!isTerminalComposerAtCursor(context)) {
    return false
  }
  return readTypedComposerText(context) !== normalizeComposerText(stripPasteFrame(payload))
}

function readTypedComposerText(context: TerminalCursorContext | null | undefined): string {
  if (!context) {
    return ''
  }
  // Why typed text only: a dim suggestion is not input; typing replaces it.
  const draft = detectTerminalComposerDraft(context, { typedOnly: true })
  return normalizeComposerText(draft?.text ?? '')
}

function stripPasteFrame(payload: string): string {
  return payload
    .replaceAll(AGENT_PROMPT_BRACKETED_PASTE_START, '')
    .replaceAll(AGENT_PROMPT_BRACKETED_PASTE_END, '')
}

// Why: the composer re-wraps and re-indents what it renders, so only the words are comparable.
function normalizeComposerText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
