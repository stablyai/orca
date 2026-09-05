/** What the rendered screen says about an injected prompt: `pending` = the composer still holds
 *  it, `clear` = a recognized composer is empty (or holds something else), `unknown` = no rendered
 *  screen, or no composer line this detector recognizes — never grounds for another Enter. */
export type AgentPromptComposerVerdict = 'pending' | 'clear' | 'unknown'

export type AgentPromptComposerScreen = {
  lines: readonly string[]
  /** Composer text the emulator extracted from the cursor rows, when it recognized one. */
  draft?: string
}

// Why: multi-line pastes collapse to a placeholder whose shape differs per TUI — Codex
// `[Pasted Content 5033 chars]`, Claude `[Pasted text #1 +91 lines]`, Grok `[Pasted: 91 lines]`,
// Hermes `[[ … [91 lines] .. ]]` — so match the shared "pasted"/"N lines" bracket, not a vendor.
const PASTE_PLACEHOLDER_RE = /\[+\s*pasted\b[^\]]*\]+|\[\d+\s+lines\]/i
// Why: composer prompts start the line with their glyph; a shell prompt like `PS C:\repo>` does not,
// and a bare `>` only counts when spaced — Codex's own banner opens with `>_ OpenAI Codex`.
const COMPOSER_PROMPT_LINE_RE = /^\s*(?:[❯›»]|>(?=\s|$))\s?(.*)$/
// Why: the composer lives at the bottom of the frame; a glyph line further up is transcript.
const COMPOSER_SCAN_LINES = 12
const PROMPT_FRAGMENT_MIN_CHARS = 6
const PROMPT_FRAGMENT_MAX_CHARS = 48

/** The prompt's first non-empty line, normalized, or null when too short to be distinctive. */
export function buildAgentPromptFragment(prompt: string): string | null {
  for (const line of prompt.split('\n')) {
    const collapsed = line.replace(/\s+/g, ' ').trim()
    if (!collapsed) {
      continue
    }
    return collapsed.length >= PROMPT_FRAGMENT_MIN_CHARS
      ? collapsed.slice(0, PROMPT_FRAGMENT_MAX_CHARS)
      : null
  }
  return null
}

export function detectAgentPromptComposerVerdict(
  screen: AgentPromptComposerScreen | null | undefined,
  prompt: string
): AgentPromptComposerVerdict {
  if (!screen || screen.lines.length === 0) {
    return 'unknown'
  }
  const fragment = buildAgentPromptFragment(prompt)
  // Why: a draft the operator typed is not the payload; another Enter would submit it, not ours.
  const draft = screen.draft?.trim()
  if (draft) {
    return holdsInjectedPayload(draft, fragment) ? 'pending' : 'clear'
  }
  const composerText = findLastComposerLineText(screen.lines)
  if (composerText === null) {
    return 'unknown'
  }
  return holdsInjectedPayload(composerText, fragment) ? 'pending' : 'clear'
}

function holdsInjectedPayload(composerText: string, fragment: string | null): boolean {
  return (
    PASTE_PLACEHOLDER_RE.test(composerText) ||
    (fragment !== null && composerText.includes(fragment))
  )
}

// Why the last glyph line only: Claude keeps `> [Pasted text …]` in its transcript after submit,
// while the empty `❯` below it is the composer that actually answers "is anything parked?".
function findLastComposerLineText(lines: readonly string[]): string | null {
  const tail = lines.filter((line) => line.trim().length > 0).slice(-COMPOSER_SCAN_LINES)
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const match = tail[index]!.match(COMPOSER_PROMPT_LINE_RE)
    if (match) {
      return match[1]!.trim()
    }
  }
  return null
}
