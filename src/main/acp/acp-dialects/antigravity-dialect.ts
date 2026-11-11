import { z } from 'zod'
import { legacyAgentSessionQuestionAnswers } from '../../../shared/agent-session/agent-session-question-answer'
import { AcpRpcError, acpErrorDataWords, type AcpAgentError } from '../transport/acp-errors'
import { readAcpPermissionRequest } from '../protocol/acp-permission-requests'
import { acpPermissionPresentation } from '../requests/acp-timeline-requests'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import {
  pendingAcpResolution,
  type AcpBackgroundTaskUpdate,
  type AcpDialect,
  type AcpDialectNotification,
  type AcpRequestPresentation
} from './acp-dialect'

// interaction_ permissions are questions, even in yolo mode; never auto-approve them.
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
      // The server accepts one offered choice and no free text.
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

// Risky Allow Always options carry warnings in option metadata.
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

// Normalize the server's command-field variants to command/cwd and stdout/exitCode.
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
  output: optionalText,
  exitCode: z.number().int().safe().optional(),
  exit_code: z.number().int().safe().optional()
})

/** Normalize Antigravity tool input and output field variants to `command`/`cwd` and `stdout`/`exitCode`. */
function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  const input = commandFieldsSchema.safeParse(update.rawInput).data
  const output = commandFieldsSchema.safeParse(update.rawOutput).data
  const command = input?.CommandLine ?? input?.command_line ?? input?.commandLine
  const cwd =
    input?.Cwd ?? input?.WorkingDirectory ?? input?.working_dir ?? input?.workingDir ?? input?.cwd
  const stdout = output?.combinedOutput ?? output?.combined_output ?? output?.output
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

const cloudCodeErrorSchema = z.object({
  error: z.object({ message: z.string().trim().min(1) })
})

/** Extract nested Cloud Code Assist JSON error messages from Antigravity prompt failures. */
function promptErrorDetail(error: AcpAgentError): string | undefined {
  const text = acpErrorDataWords(error.data) ?? error.message
  const prefix = /^Cloud Code Assist API error \(\d{3}\):\s*/.exec(text)
  if (!prefix) {
    return undefined
  }
  try {
    return cloudCodeErrorSchema.safeParse(JSON.parse(text.slice(prefix[0].length))).data?.error
      .message
  } catch {
    return undefined
  }
}

const agyBackgroundTaskSchema: z.ZodType<AcpBackgroundTaskUpdate> = z.object({
  taskId: z.string().min(1),
  state: z.enum(['working', 'monitoring', 'waiting', 'idle', 'blocked', 'done', 'unverifiable']),
  kind: z.enum(['command', 'monitor', 'agent', 'workflow', 'unknown']).optional(),
  label: z.string().optional(),
  fallbackLabel: z.string().optional(),
  fallbackKind: z.enum(['command', 'monitor', 'agent', 'workflow', 'unknown']).optional(),
  outputFile: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  parentToolUseId: z.string().optional()
})

const agyTurnUpdateSchema = z.object({
  sessionId: z.string(),
  turn: z.string().min(1).optional(),
  started: z.boolean().optional(),
  end: z.object({ stopReason: z.string() }).optional(),
  backgroundTasks: z.array(agyBackgroundTaskSchema).optional()
})

const agySessionMetaSchema = z.looseObject({
  _meta: z
    .looseObject({
      agyTurn: z.string().min(1).optional(),
      agyBackgroundTasks: z.array(agyBackgroundTaskSchema).optional()
    })
    .optional()
})

/** Map Antigravity turn-update extension frames and `_meta` fields onto ACP dialect notifications. */
function notification(method: string, params: unknown): AcpDialectNotification | undefined {
  const canonical = method.startsWith('_') ? method.slice(1) : method
  if (canonical === 'agy/turn_update') {
    const parsed = agyTurnUpdateSchema.safeParse(params)
    if (!parsed.success) {
      return { disposition: 'ignore' }
    }
    const { turn, started, end, backgroundTasks } = parsed.data
    return {
      disposition: 'map',
      ...(turn ? { turn } : {}),
      ...(started ? { started: true } : {}),
      ...(end ? { end } : {}),
      ...(backgroundTasks?.length ? { backgroundTasks } : {})
    }
  }
  if (method !== 'session/update') {
    return undefined
  }
  const meta = agySessionMetaSchema.safeParse(params).data?._meta
  if (!meta?.agyTurn && !meta?.agyBackgroundTasks?.length) {
    return undefined
  }
  return {
    disposition: 'map',
    ...(meta.agyTurn ? { turn: meta.agyTurn } : {}),
    ...(meta.agyBackgroundTasks?.length ? { backgroundTasks: meta.agyBackgroundTasks } : {})
  }
}

export const ANTIGRAVITY_ACP_DIALECT: AcpDialect = {
  request: (method, params) => questionRequest(method, params) ?? warnedApproval(method, params),
  normalizeToolUpdate,
  promptErrorDetail,
  notification,
  // Avoid using the full command line as the tool name.
  toolName: (update) => (update.kind === 'execute' ? 'execute' : undefined),
  // Logout would clear the account shared by every Antigravity chat on this host.
  withheldCommands: ['logout']
}
