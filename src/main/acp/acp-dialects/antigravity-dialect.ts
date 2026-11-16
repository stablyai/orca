import { z } from 'zod'
import type { AgentJournalApprovalSubject } from '../../../shared/agent-session/journal/agent-session-journal-approval-subject'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { legacyAgentSessionQuestionAnswers } from '../../../shared/agent-session/agent-session-question-answer'
import { AcpRpcError, acpErrorDataWords, type AcpAgentError } from '../transport/acp-errors'
import { readAcpPermissionRequest } from '../protocol/acp-permission-requests'
import { acpPermissionPresentation } from '../requests/acp-timeline-requests'
import type { ModelInfo, ToolCallUpdate } from '../generated/acp-protocol.generated'
import { pendingAcpResolution, type AcpDialect, type AcpRequestPresentation } from './acp-dialect'
import { antigravityToolSubagents } from './antigravity-subagents'

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

const planFieldsSchema = z.looseObject({
  plan: z.string().optional(),
  Path: z.string().optional(),
  Content: z.string().optional(),
  Replacement: z.string().optional(),
  ArtifactMetadata: z
    .looseObject({
      RequestFeedback: z.boolean().optional(),
      Summary: z.string().optional()
    })
    .optional()
})

function planApprovalSubject(toolCall: ToolCallUpdate): AgentJournalApprovalSubject | undefined {
  const parsed = planFieldsSchema.safeParse(toolCall.rawInput).data
  if (!parsed) {
    return undefined
  }
  const isExitPlan = toolCall.name === 'exit_plan_mode' || toolCall.title === 'Run exit_plan_mode'
  if (isExitPlan) {
    const text = parsed.plan?.trim()
    return text ? { kind: 'plan', text } : undefined
  }
  if (parsed.ArtifactMetadata?.RequestFeedback !== true) {
    return undefined
  }
  const text =
    parsed.Content?.trim() || parsed.Replacement?.trim() || parsed.ArtifactMetadata.Summary?.trim()
  if (!text) {
    return undefined
  }
  const filePath = parsed.Path?.trim()
  return { kind: 'plan', text, ...(filePath ? { filePath } : {}) }
}

// Risky Allow Always options carry warnings in option metadata; plan gates carry plan subjects.
function enrichedApproval(method: string, params: unknown): AcpRequestPresentation | undefined {
  const request =
    method === 'session/request_permission' ? readAcpPermissionRequest(params, () => {}) : null
  if (!request) {
    return undefined
  }
  const warning = request.options
    .map((option) => securityWarningSchema.safeParse(option._meta).data?.['agy.security.warning'])
    .map((found) => found?.message?.trim() || found?.title?.trim())
    .find(Boolean)
  const subject = planApprovalSubject(request.toolCall)
  return warning || subject
    ? acpPermissionPresentation(params, {
        ...(warning ? { description: warning.slice(0, WARNING_MAX_CHARS) } : {}),
        ...(subject ? { subject } : {})
      })
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

const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

// Model options list families; availableModels lists each level as "<family>-<level>".
function familyEfforts(family: string, models: readonly ModelInfo[]) {
  const efforts = EFFORT_LEVELS.flatMap((value) => {
    const variant = models.find((model) => model.modelId === `${family}-${value}`)
    return variant ? [{ value, label: /\(([^()]+)\)$/.exec(variant.name)?.[1] ?? value }] : []
  })
  return efforts.length > 0 ? { efforts } : undefined
}

function toolPlan(update: ToolCallUpdate, tool: AgentJournalToolCallItem): string | undefined {
  if (update.status !== 'completed' || tool.name !== 'exit_plan_mode') {
    return undefined
  }
  return planFieldsSchema.safeParse(tool.input).data?.plan?.trim() || undefined
}

export const ANTIGRAVITY_ACP_DIALECT: AcpDialect = {
  request: (method, params) => questionRequest(method, params) ?? enrichedApproval(method, params),
  normalizeToolUpdate,
  promptErrorDetail,
  toolPlan,
  toolSubagents: antigravityToolSubagents,
  // Avoid using the full command line as the tool name.
  toolName: (update) => (update.kind === 'execute' ? 'execute' : undefined),
  // Logout would clear the account shared by every Antigravity chat on this host.
  withheldCommands: ['logout'],
  // Exact-match single-variant models (e.g. Orchestrator) expose no thinking-level menu.
  modelEfforts: () => ({ efforts: [] }),
  familyEfforts
}
