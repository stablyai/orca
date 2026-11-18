import { z } from 'zod'
import type { ToolCallContent, ToolCallUpdate } from '../generated/acp-protocol.generated'
import { readAcpPermissionRequest } from '../protocol/acp-permission-requests'
import { acpPermissionPresentation } from '../requests/acp-timeline-requests'
import type {
  AcpCompactionReply,
  AcpDialect,
  AcpDialectNotification,
  AcpRequestPresentation
} from './acp-dialect'

const TOOL_TITLE = /^([a-z][a-z0-9_]*)(?::\s+([\s\S]+)|$)/u
const COMMAND_PREVIEW = /^\$ ([\s\S]+)$/u
// Hermes renders a terminal result as markdown bullets: output (when any), exit code, then notes.
// Other notes, such as where truncated output was saved, keep Hermes' own rendering.
const TERMINAL_RESULT =
  /^terminal result\n(?:- \*\*output:\*\* ([\s\S]*?)\n)?- \*\*exit_code:\*\* (-?\d+)(?:\n- \*\*(?:approval|error):\*\* [^\n]*)*$/u
const EXIT_CODE_LINE = '\n- **exit_code:** '
// Hermes' own notice, never the model's words: it opens the reply of a prompt it refused.
const NO_PROVIDER = /^(?:\u26A0\uFE0F )?Hermes is not connected to any AI provider yet\./u
const COMPRESSION_SKIPPED =
  /^(?:No changes from compression|Compression refused|Nothing to compress|Preview\b)/u
const COMPRESSION_FAILED = /^(?:\u274C |\u26A0\uFE0F )?Compression (?:aborted|failed)\b/u
// Questions and model-switch confirmations arrive as permission requests; only the person answers.
const DECISION_REQUEST = /^(?:clarify|model-confirm)-/u

function textBlock(block: ToolCallContent): string | undefined {
  return block.type === 'content' && block.content.type === 'text' ? block.content.text : undefined
}

function firstText(update: ToolCallUpdate): string | undefined {
  return update.content?.map(textBlock).find(Boolean)
}

function withoutText(update: ToolCallUpdate, text: string): ToolCallContent[] | undefined {
  return update.content?.filter((block) => textBlock(block) !== text)
}

// Calls carry no arguments: a command is only in its `$ <command>` preview, a target only in locations.
function runningCall(update: ToolCallUpdate): ToolCallUpdate {
  if (update.rawInput !== undefined) {
    return update
  }
  const preview = update.kind === 'execute' ? firstText(update) : undefined
  const command = preview ? COMMAND_PREVIEW.exec(preview)?.[1] : undefined
  if (preview && command) {
    return { ...update, rawInput: { command }, content: withoutText(update, preview) }
  }
  const path = update.locations?.[0]?.path
  if (path) {
    return { ...update, rawInput: { path } }
  }
  // Some calls name their target only in the title, which `toolName` reduces to the tool.
  const target = update.title ? TOOL_TITLE.exec(update.title)?.[2] : undefined
  return target ? { ...update, rawInput: target } : update
}

function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  if (update.status !== 'completed' && update.status !== 'failed') {
    return runningCall(update)
  }
  const text = firstText(update)
  // Output that prints the exit-code line itself is ambiguous; keep Hermes' own rendering.
  const result =
    text?.startsWith('terminal result\n') &&
    text.indexOf(EXIT_CODE_LINE) === text.lastIndexOf(EXIT_CODE_LINE)
      ? TERMINAL_RESULT.exec(text)
      : null
  if (!text || !result) {
    return update
  }
  return {
    ...update,
    rawOutput: { stdout: result[1] ?? '', exitCode: Number(result[2]) },
    content: withoutText(update, text)
  }
}

// Reads only these fields, so the many tool updates of a turn are rejected at the literal.
const replyTextSchema = z.object({
  update: z.object({
    sessionUpdate: z.literal('agent_message_chunk'),
    content: z.object({ type: z.literal('text'), text: z.string() })
  })
})

// A signed-out prompt replies with this sentence, then fails with a generic admitted_turn_failed.
function notification(method: string, params: unknown): AcpDialectNotification | undefined {
  const text =
    method === 'session/update'
      ? replyTextSchema.safeParse(params).data?.update.content.text
      : undefined
  return text && NO_PROVIDER.test(text)
    ? {
        disposition: 'map',
        failure: { stopReason: 'error', notSignedIn: true, failureDetail: text.trim() }
      }
    : undefined
}

function compactionReply(text: string): AcpCompactionReply | undefined {
  const reply = text.trim()
  return COMPRESSION_SKIPPED.test(reply)
    ? { outcome: 'skipped', detail: reply }
    : COMPRESSION_FAILED.test(reply)
      ? { outcome: 'failed', detail: reply }
      : undefined
}

function decisionRequest(method: string, params: unknown): AcpRequestPresentation | undefined {
  const request =
    method === 'session/request_permission' ? readAcpPermissionRequest(params, () => {}) : null
  return request && DECISION_REQUEST.test(request.toolCall.toolCallId)
    ? acpPermissionPresentation(params)
    : undefined
}

export const HERMES_ACP_DIALECT: AcpDialect = {
  normalizeToolUpdate,
  // Titles are `<tool>: <preview>`; the preview is the call's input, not its name.
  toolName: (update) => (update.title ? TOOL_TITLE.exec(update.title)?.[1] : undefined),
  notification,
  compactCommand: '/compress',
  // Orca's /compact runs /compress, and /reset would empty the session under the chat's transcript.
  withheldCommands: ['compress', 'reset'],
  compactionReply,
  request: decisionRequest,
  reopenMovesSession: true
}
