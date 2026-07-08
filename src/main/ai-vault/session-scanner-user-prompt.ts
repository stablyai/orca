import { asRecord, extractString } from './session-scanner-values'

// Kept generous so the prompt timeline can show more than a one-line preview;
// the renderer clamps for display.
export const USER_PROMPT_TEXT_LIMIT = 4000

// Wrapper blocks Claude Code embeds inside a type:'user' record that are not
// part of what the user typed (slash-command plumbing, hook output, injected
// notifications). Backreference keeps each open/close tag pair matched.
const WRAPPER_BLOCK_RE =
  /<(system-reminder|command-name|command-message|command-args|local-command-stdout|user-prompt-submit-hook|task-notification)>[\s\S]*?<\/\1>/g

// Whole-message markers that arrive as type:'user' but were machine-injected —
// Orca orchestration dispatch preamble/inbox delivery/handoff, cross-session
// teammate messages, and the CLI's own interrupt notices. These carry
// promptSource:'typed' (Orca feeds them through stdin), so text is the only
// signal; best-effort by design. The dispatch-preamble anchor also keeps pure
// orchestration-worker sessions (only injected input) out of the timeline.
const INJECTED_MESSAGE_RE =
  /^(?:---\s*Orchestration Messages|You are working inside Orca, a multi-agent IDE\. You are a dispatched worker\.|Tienes un mensaje de handoff|You have a handoff|Another Claude session sent a message|\[Request interrupted)/

const TEAMMATE_MESSAGE_RE = /<teammate-message\b/

function isSuppressedInstructionPrefix(text: string): boolean {
  return /^# AGENTS\.md instructions\b/i.test(text) || /^<INSTRUCTIONS>/i.test(text)
}

// Extract the human-typed prompt from a Claude transcript record, or null when
// the record is not a genuine user prompt (tool result, injected context,
// subagent turn, compaction summary, orchestration/interrupt notice).
export function extractClaudeUserPromptText(record: Record<string, unknown>): string | null {
  if (record.type !== 'user') {
    return null
  }
  // Structural exclusions: injected context, in-session subagent turns, the
  // compaction summary, and interrupt notices all reuse type:'user'.
  if (
    record.isMeta === true ||
    record.isSidechain === true ||
    record.isCompactSummary === true ||
    record.interruptedMessageId !== undefined
  ) {
    return null
  }

  const raw = collectTypedText(asRecord(record.message)?.content)
  if (raw === null) {
    return null
  }

  const cleaned = raw
    .replace(WRAPPER_BLOCK_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  if (!cleaned) {
    return null
  }
  if (INJECTED_MESSAGE_RE.test(cleaned) || TEAMMATE_MESSAGE_RE.test(cleaned)) {
    return null
  }
  if (isSuppressedInstructionPrefix(cleaned)) {
    return null
  }

  return cleaned.length > USER_PROMPT_TEXT_LIMIT
    ? cleaned.slice(0, USER_PROMPT_TEXT_LIMIT).trimEnd()
    : cleaned
}

// Join the human-authored text of a user message, dropping tool_result/tool_use/
// image blocks — Claude records tool output as type:'user' records too.
function collectTypedText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }
  const parts: string[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    const record = asRecord(item)
    if (!record || record.type === 'tool_result' || record.type === 'tool_use' || record.type === 'image') {
      continue
    }
    const text = extractString(record.text)
    if (text) {
      parts.push(text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}
