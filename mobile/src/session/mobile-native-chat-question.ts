// Heuristic detection of an agent's "pick an option" prompt from its status /
// assistant text. Agents (Claude et al.) render these as a TUI choice list; we
// have no structured signal, so we parse the text conservatively and only treat
// it as a question when a clear option list is present.

export type MobileChatQuestion = {
  question: string
  options: string[]
  multiSelect: boolean
  /** Per-option leading marker ("1", "b", …) when the source line carried one,
   *  parallel to `options`. Null where the option was a plain bullet. Used to
   *  echo the exact choice the agent listed back to the terminal. */
  optionTokens: (string | null)[]
}

export function mobileChatQuestionKey(question: MobileChatQuestion): string {
  return JSON.stringify(question)
}

type ParsedOption = {
  label: string
  token: string | null
}

// A pointer/highlight glyph some TUIs prefix onto the *currently selected* row.
// Stripped first so "❯ 2. Foo" parses identically to "2. Foo".
const POINTER_PREFIX = /^(\s*)(?:❯|›|»)\s+/

// Ordered most-specific-first so a numbered/lettered marker wins over the
// bullet fallback. `token` is the capture index of the leading marker (0 = none),
// `label` the capture index of the choice text.
const OPTION_PATTERNS: { re: RegExp; token: number; label: number }[] = [
  // 1. Option   12) Option
  { re: /^\s*(\d{1,2})[.)]\s+(\S.*?)\s*$/, token: 1, label: 2 },
  // [a] Option   [1] Option
  { re: /^\s*\[([0-9a-zA-Z])\]\s+(\S.*?)\s*$/, token: 1, label: 2 },
  // a) Option   a. Option   (single letter, to avoid eating prose like "e.g.")
  { re: /^\s*([a-zA-Z])[.)]\s+(\S.*?)\s*$/, token: 1, label: 2 },
  // - Option   * Option   • Option   > Option   (no token)
  { re: /^\s*(?:[-*•>])\s+(\S.*?)\s*$/, token: 0, label: 1 }
]

function parseOptionLine(line: string): ParsedOption | null {
  const stripped = line.replace(POINTER_PREFIX, '$1')
  for (const { re, token, label } of OPTION_PATTERNS) {
    const m = stripped.match(re)
    if (!m) {
      continue
    }
    const text = m[label].trim()
    if (text.length === 0) {
      continue
    }
    return { label: text, token: token > 0 ? m[token] : null }
  }
  return null
}

const MULTI_SELECT_HINT =
  /\b(select all|choose all|choose multiple|select multiple|pick multiple|all that apply|one or more|comma[- ]separated|multiple options)\b/i

// Question-like introducing line: ends in ? or :.
const QUESTION_LINE = /[?:]\s*$/

// Drop a trailing ":" off a card title but keep a meaningful "?".
function cleanQuestionText(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.endsWith(':') ? trimmed.slice(0, -1).trim() : trimmed
}

/**
 * Heuristically parse a question + its option list from agent text. Returns null
 * when no clear option list is present (so ordinary prose is never treated as a
 * question). Conservative on purpose: requires at least two option lines, or one
 * option line introduced by a question-like prompt line.
 */
export function parseAgentQuestion(text: string): MobileChatQuestion | null {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const parsed: { index: number; option: ParsedOption }[] = []

  lines.forEach((line, index) => {
    const option = parseOptionLine(line)
    if (option) {
      parsed.push({ index, option })
    }
  })

  if (parsed.length === 0) {
    return null
  }

  const firstOptionIndex = parsed[0].index
  const options = parsed.map((p) => p.option.label)
  const optionTokens = parsed.map((p) => p.option.token)

  // Find the introducing question: nearest non-empty, non-option line above the
  // first option.
  let question = ''
  let questionLooksLikePrompt = false
  for (let i = firstOptionIndex - 1; i >= 0; i--) {
    if (lines[i].trim().length === 0 || parseOptionLine(lines[i])) {
      continue
    }
    question = lines[i]
    questionLooksLikePrompt = QUESTION_LINE.test(lines[i])
    break
  }

  // Conservative gate: a single bare option with no introducing prompt is more
  // likely stray prose (a lone "- item") than a real choice list.
  if (options.length < 2 && !questionLooksLikePrompt) {
    return null
  }

  const multiSelect = MULTI_SELECT_HINT.test(text) && options.length > 1

  return {
    question: question.length > 0 ? cleanQuestionText(question) : 'Choose an option',
    options,
    multiSelect,
    optionTokens
  }
}

/**
 * Build the text to send to the agent terminal for the selected option(s).
 * Convention: echo the option's leading marker (number/letter) when the list had
 * one; otherwise send the option label text (TUIs accept the literal choice).
 * Multi-select answers are comma-joined; single-select is sent as-is. Unknown
 * entries (free-text escape hatch) pass through verbatim. Returns '' when
 * nothing is selected.
 */
export function formatQuestionAnswer(question: MobileChatQuestion, selected: string[]): string {
  const labels = selected.map((s) => s.trim()).filter((s) => s.length > 0)
  if (labels.length === 0) {
    return ''
  }

  const parts = labels.map((label) => {
    const index = question.options.indexOf(label)
    if (index === -1) {
      // Free-text / unknown entry: pass the user's text straight through.
      return label
    }
    const token = question.optionTokens[index]
    return token != null && token.length > 0 ? token : label
  })

  return parts.join(question.multiSelect ? ', ' : ' ')
}
