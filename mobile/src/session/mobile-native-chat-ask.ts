import type { NativeChatBlock, NativeChatMessage } from '../../../src/shared/native-chat-types'
import type {
  AskOption,
  AskPrompt,
  AskQuestion,
  InteractiveQuestionParser
} from '../../../src/shared/native-chat-ask-types'

// Why: Claude's AskUserQuestion tool records its full structured prompt (question
// text + options) in the transcript as a tool-call block. Since the mobile chat
// already streams the transcript, we render that structure natively instead of
// heuristically parsing status text. A prompt is "pending" while its tool-call is
// the most recent tool activity with no following tool-result.
//
// Why: the Ask question parser (parseQuestionsShape/parseOptions/the
// QUESTION_TOOL_PARSERS registry/parseToolInput/formatAskAnswer) is a byte-for-byte
// mirror of desktop's `native-chat-interactive-prompt.ts` — Metro can't import these
// runtime values from src/shared (types are shared via `import type` above), so both
// copies must stay in sync; parity is asserted by
// `src/shared/native-chat-ask-parser-parity.test.ts`.

export type { AskOption, AskPrompt, AskQuestion, InteractiveQuestionParser }

// Registry of question-tool parsers keyed by the tool name the agent reports.
// To support a new terminal/agent's question tool, register its parser here (or
// via registerQuestionTool) — the renderer and wiring stay unchanged.
const QUESTION_TOOL_PARSERS = new Map<string, InteractiveQuestionParser>()

export function registerQuestionTool(toolName: string, parser: InteractiveQuestionParser): void {
  QUESTION_TOOL_PARSERS.set(toolName, parser)
}

/** Claude's AskUserQuestion shape: `{ questions: [{ question, header,
 *  multiSelect, options: [{ label, description }] }] }`. Also the de-facto
 *  default shape, so a new agent that reuses it works without registration. */
function parseQuestionsShape(input: unknown): AskPrompt | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const rawQuestions = (input as { questions?: unknown }).questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return null
  }
  const questions: AskQuestion[] = []
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const q = raw as Record<string, unknown>
    const question = typeof q.question === 'string' ? q.question : ''
    const options = parseOptions(q.options)
    if (question || options.length > 0) {
      questions.push({
        question,
        header: typeof q.header === 'string' ? q.header : undefined,
        multiSelect: q.multiSelect === true,
        options
      })
    }
  }
  return questions.length > 0 ? { questions } : null
}

function parseOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((o): AskOption | null => {
      if (typeof o === 'string') {
        return { label: o }
      }
      if (o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string') {
        const obj = o as { label: string; description?: unknown }
        return {
          label: obj.label,
          description: typeof obj.description === 'string' ? obj.description : undefined
        }
      }
      return null
    })
    .filter((o): o is AskOption => o !== null)
}

// Claude's AskUserQuestion (and aliases) ship the canonical questions shape.
for (const name of ['AskUserQuestion', 'ask_user_question', 'askUserQuestion']) {
  QUESTION_TOOL_PARSERS.set(name, parseQuestionsShape)
}

/** Resolve an interactive-prompt payload to an AskPrompt: try the tool's
 *  registered parser first, then fall back to the canonical questions shape so a
 *  new agent that happens to use the same structure works without registration. */
function parseToolInput(toolName: string | undefined, input: unknown): AskPrompt | null {
  const parser = toolName ? QUESTION_TOOL_PARSERS.get(toolName) : undefined
  return (parser ? parser(input) : null) ?? parseQuestionsShape(input)
}

/** Parse the live `agentStatus.interactivePrompt` (the agent's untruncated
 *  question-tool input as JSON) — the reliable source for a pending question,
 *  since the transcript isn't written until the question is answered. */
export function parseAskFromStatus(
  interactivePrompt: string | undefined | null,
  toolName?: string
): AskPrompt | null {
  if (!interactivePrompt) {
    return null
  }
  try {
    return parseToolInput(toolName, JSON.parse(interactivePrompt))
  } catch {
    return null
  }
}

function questionToolFor(block: NativeChatBlock): InteractiveQuestionParser | null {
  if (block.type !== 'tool-call') {
    return null
  }
  return QUESTION_TOOL_PARSERS.get(block.name) ?? null
}

/** The most recent interactive question still awaiting an answer, or null. Blocks
 *  carry no tool ids, so a tool-result resolves the OLDEST outstanding tool-call
 *  (FIFO). The ask is cleared only when its own call is the one resolved — a
 *  parallel sibling tool's result (e.g. arriving after reconnect) must not clear
 *  an unanswered question. */
export function extractPendingAsk(messages: readonly NativeChatMessage[]): AskPrompt | null {
  let pending: AskPrompt | null = null
  // FIFO of outstanding tool-calls; each entry is the ask prompt it started, or
  // null for a non-ask call (still queued so it consumes its own result).
  const outstanding: Array<AskPrompt | null> = []
  for (const message of messages) {
    for (const block of message.blocks) {
      const parser = questionToolFor(block)
      if (block.type === 'tool-call') {
        const parsed = parser ? parser(block.input) : null
        if (parsed) {
          pending = parsed
        }
        outstanding.push(parsed)
      } else if (block.type === 'tool-result' && outstanding.length > 0) {
        const resolved = outstanding.shift()
        if (resolved && resolved === pending) {
          pending = null
        }
      }
    }
  }
  return pending
}

/** Build the answer text to send to the agent: exactly one line per question, in
 *  question order, each the selected option label(s). Empty answers stay as empty
 *  lines (not dropped) so N lines always == N questions — the per-question Enter
 *  stepping counts one Enter per line, so dropping a blank middle answer would
 *  misalign the count and leave the prompt unsubmitted. */
export function formatAskAnswer(prompt: AskPrompt, selections: string[][]): string {
  return prompt.questions.map((_, i) => (selections[i] ?? []).join(', ')).join('\n')
}

/** Returns a position-preserving answer only when every question is complete. */
export function formatCompleteAskAnswer(answers: readonly string[]): string | null {
  const normalized = answers.map((answer) => answer.trim())
  return normalized.length > 0 && normalized.every((answer) => answer.length > 0)
    ? normalized.join('\n')
    : null
}
