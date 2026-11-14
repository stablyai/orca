import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import { readAcpPermissionRequest } from '../protocol/acp-permission-requests'
import { acpPermissionPresentation } from '../requests/acp-timeline-requests'
import type { AcpDialect, AcpRequestPresentation } from './acp-dialect'

const SHELL_FAILURE = /^(?:([\s\S]*)\n)?Command failed with exit code: (-?\d+)\.$/u
const SHELL_SILENT_SUCCESS = 'Command executed successfully.'

// Kimi's Bash result is one string: output, then a failure line on a non-zero exit.
function shellResult(
  output: string,
  status: ToolCallUpdate['status']
): { stdout: string; exitCode: number } | null {
  if (status === 'completed') {
    return output === SHELL_SILENT_SUCCESS ? { stdout: '', exitCode: 0 } : null
  }
  const failure = status === 'failed' ? SHELL_FAILURE.exec(output) : null
  if (!failure) {
    return null
  }
  const exitCode = Number(failure[2])
  const stdout = failure[1] ?? ''
  return { stdout: stdout === `Process exited with code ${exitCode}` ? '' : stdout, exitCode }
}

function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  // A running call's text is its streamed arguments, not output.
  if (update.status === 'pending' || update.status === 'in_progress') {
    return update.content
      ? {
          ...update,
          content: update.content.filter(
            (block) => !(block.type === 'content' && block.content.type === 'text')
          )
        }
      : update
  }
  const output = update.rawOutput
  const shell = typeof output === 'string' ? shellResult(output, update.status) : null
  if (!shell) {
    return update
  }
  return {
    ...update,
    rawOutput: shell,
    content: update.content?.filter(
      (block) =>
        !(
          block.type === 'content' &&
          block.content.type === 'text' &&
          block.content.text === output
        )
    )
  }
}

const APPROVAL_ACTION = /^Requesting approval to (.+)$/su
const ACTION_MAX_CHARS = 512

// Approvals are titled with the bare tool name; the command or path is only in this action line.
function approvalRequest(method: string, params: unknown): AcpRequestPresentation | undefined {
  const request =
    method === 'session/request_permission' ? readAcpPermissionRequest(params, () => {}) : null
  const action = request?.toolCall.content
    ?.map((block) =>
      block.type === 'content' && block.content.type === 'text'
        ? APPROVAL_ACTION.exec(block.content.text)?.[1]?.trim()
        : undefined
    )
    .find(Boolean)
  return action ? acpPermissionPresentation(params, action.slice(0, ACTION_MAX_CHARS)) : undefined
}

export const KIMI_ACP_DIALECT: AcpDialect = {
  // Without forms, Kimi drops every question after the first and offers no free-text answer.
  clientCapabilities: { elicitation: { form: {} } },
  normalizeToolUpdate,
  request: approvalRequest
}
