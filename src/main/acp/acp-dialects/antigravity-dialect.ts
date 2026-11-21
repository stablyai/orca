import { z } from 'zod'
import type { AgentJournalApprovalSubject } from '../../../shared/agent-session/journal/agent-session-journal-approval-subject'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { legacyAgentSessionQuestionAnswers } from '../../../shared/agent-session/requests/prompts/agent-session-question-answer'
import { AcpRpcError, acpErrorDataWords, type AcpAgentError } from '../transport/acp-errors'
import { readAcpPermissionRequest } from '../protocol/acp-permission-requests'
import {
  ACP_FORM_ELICITATION_METHOD,
  acpFormElicitationPresentation
} from '../requests/acp-form-elicitation'
import { acpPermissionPresentation } from '../requests/acp-timeline-requests'
import type { ModelInfo, ToolCallUpdate } from '../generated/acp-protocol.generated'
import { pendingAcpResolution, type AcpDialect, type AcpRequestPresentation } from './acp-dialect'
import { antigravityToolSubagents } from './antigravity-subagents'
import { acpReplyNoticeFailure } from './acp-reply-notice-failure'
import {
  ANTIGRAVITY_EFFORT_LEVELS,
  ANTIGRAVITY_LEVEL_SUFFIX
} from '../../../shared/agent-session/options/catalog-providers/agent-session-option-catalog-antigravity'

// The server's question forms open with only a count; each field's title is the real question.
const QUESTION_FORM_MESSAGE = /^The agent has (?:a question|\d+ questions)\.$/
const formMessageSchema = z.looseObject({ mode: z.literal('form'), message: z.string() })

function questionForm(method: string, params: unknown): AcpRequestPresentation | undefined {
  if (method !== ACP_FORM_ELICITATION_METHOD) {
    return undefined
  }
  const form = formMessageSchema.safeParse(params).data
  return form && QUESTION_FORM_MESSAGE.test(form.message)
    ? acpFormElicitationPresentation({ ...form, message: '' })
    : undefined
}

// Formless servers ask via interaction_ permissions; never auto-approve them, even in yolo mode.
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

function isExitPlanModeTool(
  name: string | null | undefined,
  title: string | null | undefined
): boolean {
  return (
    name === 'exit_plan_mode' || name === 'Run exit_plan_mode' || title === 'Run exit_plan_mode'
  )
}

function planApprovalSubject(toolCall: ToolCallUpdate): AgentJournalApprovalSubject | undefined {
  const parsed = planFieldsSchema.safeParse(toolCall.rawInput).data
  if (!parsed) {
    return undefined
  }
  if (isExitPlanModeTool(toolCall.name, toolCall.title)) {
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

// agy 1.5+ retries an empty model reply until it gets output, sending this text each time.
const RETRY_NOTICE = /^\s*\u26a0 (Model produced invalid output\.)\s*$/

// Notices that end a turn as failed: agy's when a request outlived its OAuth token, its
// executor-error line when it couldn't run the turn at all (a rejected Gemini API key, quota, a
// server error), and the one when it could not rebuild its agent, whose reason may span lines;
// Orca's server answers a rejected key or missing gcloud credentials the same way.
const TURN_FAILURE_NOTICE =
  /^\s*(?:\u26a0 (?:UNAUTHENTICATED \(code 401\)|agent executor error): [^\n]*|API key not valid\. Please pass a valid API key\.|Agent execution error: failed to create Gemini client: [^\n]*|Agent connection was lost and could not be re-established: Failed to rebuild agent: [\s\S]*)\s*$/
// agy drops a session whose agent it cannot rebuild; later prompts find no session.
const REBUILD_FAILED = 'Failed to rebuild agent: '

// Model options list families; availableModels lists each level as "<family>-<level>".
function familyEfforts(family: string, models: readonly ModelInfo[]) {
  const efforts = ANTIGRAVITY_EFFORT_LEVELS.flatMap((value) => {
    const variant = models.find((model) => model.modelId === `${family}-${value}`)
    return variant ? [{ value, label: /\(([^()]+)\)$/.exec(variant.name)?.[1] ?? value }] : []
  })
  return efforts.length > 0 ? { efforts } : undefined
}

/** The model choices a chat offers: a family for levels listed as "<family>-<level>" (two or
 *  more, and the family isn't a model itself), every other model on its own. */
export function antigravityModelChoices(
  models: readonly Pick<ModelInfo, 'modelId' | 'name'>[]
): { id: string; label: string }[] {
  const ids = new Set(models.map((model) => model.modelId))
  const levels = new Map<string, number>()
  for (const model of models) {
    const family = ANTIGRAVITY_LEVEL_SUFFIX.exec(model.modelId)?.[1]
    if (family && !ids.has(family)) {
      levels.set(family, (levels.get(family) ?? 0) + 1)
    }
  }
  const choices = new Map<string, string>()
  for (const model of models) {
    const family = ANTIGRAVITY_LEVEL_SUFFIX.exec(model.modelId)?.[1]
    if (family && (levels.get(family) ?? 0) > 1) {
      if (!choices.has(family)) {
        choices.set(family, model.name.replace(/\s*\([^()]+\)$/, ''))
      }
    } else {
      choices.set(model.modelId, model.name)
    }
  }
  return [...choices].map(([id, label]) => ({ id, label }))
}

function toolPlan(update: ToolCallUpdate, tool: AgentJournalToolCallItem): string | undefined {
  if (update.status !== 'completed' || !isExitPlanModeTool(tool.name, update.title)) {
    return undefined
  }
  return planFieldsSchema.safeParse(tool.input).data?.plan?.trim() || undefined
}

export const ANTIGRAVITY_ACP_DIALECT: AcpDialect = {
  // With forms, ask_question carries a write-in field per question; permissions cannot carry text.
  clientCapabilities: { elicitation: { form: {} } },
  request: (method, params) =>
    questionForm(method, params) ??
    questionRequest(method, params) ??
    enrichedApproval(method, params),
  // Calls past WaitMsBeforeAsync, subagents and schedules finish after end_turn (#40447).
  reactiveWakeups: true,
  normalizeToolUpdate,
  promptErrorDetail,
  toolPlan,
  toolSubagents: antigravityToolSubagents,
  sessionLost: (error, sessionId) => {
    const detail = acpErrorDataWords(error.data)
    return (
      detail === `Session not found: ${sessionId}` || detail?.startsWith(REBUILD_FAILED) === true
    )
  },
  // A rebuild that fails mid-turn arrives as a reply notice, and the prompt then ends normally.
  sessionLostNotice: (notice) => notice.includes(REBUILD_FAILED),
  // Not marked signed out: agy may already hold a refreshed token for the next prompt.
  notification: (method, params) => acpReplyNoticeFailure(method, params, TURN_FAILURE_NOTICE),
  providerRetry: (text) => RETRY_NOTICE.exec(text)?.[1],
  // Avoid using the full command line as the tool name.
  toolName: (update) => (update.kind === 'execute' ? 'execute' : undefined),
  // Logout would clear the account shared by every Antigravity chat on this host.
  withheldCommands: ['logout'],
  // Exact-match single-variant models (e.g. Orchestrator) expose no thinking-level menu.
  modelEfforts: () => ({ efforts: [] }),
  familyEfforts
}
