import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpAgentError } from '../transport/acp-errors'
import { readAcpPermissionRequest } from '../protocol/acp-permission-requests'
import { acpPermissionPresentation } from '../requests/acp-timeline-requests'
import type { AcpDialect, AcpRequestPresentation, AcpTurnEnding } from './acp-dialect'

// Vibe uses a synthetic tool_call for conversation history compaction (see mistralai/mistral-vibe deepwiki).
// The tool_call has kind: "other" and a title like "Compacting conversation history..."
// const COMPACTION_TOOL_TITLE = /^Compacting conversation history\.\.\.$/u

function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  // Completion updates can carry streamed text that's not part of the real output.
  // Vibe does not seem to stream to tool rawOutput; keep update as-is.
  return update
}

const APPROVAL_NAME = /^Requesting (?:approval|permission) to (.+)$/iu
const REQUEST_MAX_CHARS = 512

// Vibe sends permission requests as session/request_permission notifications.
function approvalRequest(method: string, params: unknown): AcpRequestPresentation | undefined {
  const request =
    method === 'session/request_permission' ? readAcpPermissionRequest(params, () => {}) : null
  const name = request?.toolCall.content
    ?.map((block) =>
      block.type === 'content' && block.content.type === 'text'
        ? APPROVAL_NAME.exec(block.content.text)?.[1]?.trim()
        : undefined
    )
    .find(Boolean)
  return name ? acpPermissionPresentation(params, name.slice(0, REQUEST_MAX_CHARS)) : undefined
}

// Vibe tool-calls for known shell commands: drop the synthetic running text.
function toolName(_update: ToolCallUpdate): string | undefined {
  // Vibe tool calls carry an id; keep the name if present.
  // Run-time: the client describes the tool, not the TUI.
  return undefined
}

// Vibe uses question forms (no native text answers to approvals).
function settleRequest(
  _method: string,
  _params: unknown
): { reply: unknown; plan?: string } | undefined {
  // Vibe does not return answers inline; settle via the generic ACP path.
  return undefined
}

function promptFailure(
  error: AcpAgentError,
  _at: number
): Pick<AcpTurnEnding, 'stopReason' | 'usageLimit' | 'providerFailure'> | undefined {
  // Map vibe-specific stop reasons.
  // Vibe returns cancelled on user stop during pending approvals (verified in releases).
  if (error.code === -32000 && error.message?.toLowerCase().includes('cancelled')) {
    return { stopReason: 'cancelled' }
  }
  // Rate limit / token limit would show here; keep default ACP handling otherwise.
  return undefined
}

export const VIBE_ACP_DIALECT: AcpDialect = {
  // Vibe supports ACP form-based elicitation for questions (confirmed in deepwiki).
  clientCapabilities: { elicitation: { form: {} } },
  normalizeToolUpdate,
  toolName,
  request: approvalRequest,
  settleRequest,
  promptFailure
  // Completion of compaction tool calls should not start a new turn.
  // Mark them as non-interactive so chat UI doesn't show them as user-answerable.
  // ACP layer already handles tool-calls generically; just ensure we recognize them.
}
