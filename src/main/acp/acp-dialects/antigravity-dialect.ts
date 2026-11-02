import { z } from 'zod'
import { legacyAgentSessionQuestionAnswers } from '../../../shared/agent-session-question-answer'
import { AcpRpcError } from '../acp-errors'
import { readAcpPermissionRequest } from '../acp-permission-requests'
import { acpPermissionPresentation, pendingAcpResolution } from '../acp-timeline-requests'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpDialect, AcpRequestPresentation } from './acp-dialect'

// Antigravity asks the person a question as a permission request on an `interaction_` tool call,
// one choice per option, sent even in its yolo mode: a question, never an approval to auto-allow.
function questionRequest(method: string, params: unknown): AcpRequestPresentation | undefined {
  const request =
    method === 'session/request_permission' ? readAcpPermissionRequest(params, () => {}) : null
  if (!request?.toolCall.toolCallId.startsWith('interaction_')) {
    return undefined
  }
  const body = {
    kind: 'question' as const,
    question: request.toolCall.title ?? 'Question',
    options: request.options.map((option) => ({ id: option.optionId, label: option.name })),
    resolution: pendingAcpResolution
  }
  return {
    body,
    reply: (response) => {
      if (response === null) {
        return { outcome: { outcome: 'cancelled' } }
      }
      const answers =
        response.kind === 'answers'
          ? response.answers
          : legacyAgentSessionQuestionAnswers(body, response.optionId)
      const [answer] = answers ?? []
      const optionId = answer?.optionIds[0]
      // The server takes back one of its own choices; it has no free-text answer.
      if (
        answers?.length !== 1 ||
        answer?.optionIds.length !== 1 ||
        answer.other?.trim() ||
        !body.options.some((option) => option.id === optionId)
      ) {
        throw new AcpRpcError(-32602, 'Question answer must choose one offered option')
      }
      return { outcome: { outcome: 'selected', optionId } }
    }
  }
}

const WARNING_MAX_CHARS = 512
const securityWarningSchema = z.looseObject({
  'agy.security.warning': z.looseObject({
    title: z.string().optional(),
    message: z.string().optional()
  })
})

// The server marks a risky "Allow Always" with a prompt-injection warning in that option's `_meta`.
function warnedApproval(method: string, params: unknown): AcpRequestPresentation | undefined {
  const request =
    method === 'session/request_permission' ? readAcpPermissionRequest(params, () => {}) : null
  const warning = request?.options
    .map((option) => securityWarningSchema.safeParse(option._meta).data?.['agy.security.warning'])
    .map((found) => found?.message?.trim() || found?.title?.trim())
    .find(Boolean)
  return warning
    ? acpPermissionPresentation(params, warning.slice(0, WARNING_MAX_CHARS))
    : undefined
}

// A command arrives as `rawInput {command_line, working_dir}`, and once done as `rawOutput
// {commandLine, workingDir, exitCode, combinedOutput, formatted_output}` with no content blocks;
// the shared shape is `rawInput.command` and `rawOutput {stdout, exitCode}`.
const optionalText = z.string().optional()
const commandFieldsSchema = z.looseObject({
  CommandLine: optionalText,
  command_line: optionalText,
  commandLine: optionalText,
  Cwd: optionalText,
  WorkingDirectory: optionalText,
  working_dir: optionalText,
  workingDir: optionalText,
  cwd: optionalText,
  combinedOutput: optionalText,
  combined_output: optionalText,
  exitCode: z.number().int().safe().optional(),
  exit_code: z.number().int().safe().optional()
})

function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  const input = commandFieldsSchema.safeParse(update.rawInput).data
  const output = commandFieldsSchema.safeParse(update.rawOutput).data
  const command = input?.CommandLine ?? input?.command_line ?? input?.commandLine
  const cwd =
    input?.Cwd ?? input?.WorkingDirectory ?? input?.working_dir ?? input?.workingDir ?? input?.cwd
  const stdout = output?.combinedOutput ?? output?.combined_output
  const exitCode = output?.exitCode ?? output?.exit_code
  return {
    ...update,
    ...(command === undefined
      ? {}
      : { rawInput: { command, ...(cwd === undefined ? {} : { cwd }) } }),
    ...(stdout === undefined && exitCode === undefined
      ? {}
      : {
          rawOutput: {
            ...(stdout === undefined ? {} : { stdout }),
            ...(exitCode === undefined ? {} : { exitCode })
          }
        })
  }
}

export const ANTIGRAVITY_ACP_DIALECT: AcpDialect = {
  request: (method, params) => questionRequest(method, params) ?? warnedApproval(method, params),
  normalizeToolUpdate,
  // Its command's title is the command line itself; the kind is what names a command row.
  toolName: (update) => (update.kind === 'execute' ? 'execute' : undefined),
  // The server's own sign-out clears the sign-in every Antigravity chat on the host shares.
  withheldCommands: ['logout']
}
