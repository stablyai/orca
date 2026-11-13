import { z } from 'zod'
import {
  isValidAgentSessionQuestionAnswers,
  legacyAgentSessionQuestionAnswers
} from '../../../shared/agent-session/agent-session-question-answer'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import { readAcpPermissionRequest } from '../protocol/acp-permission-requests'
import { AcpRpcError } from '../transport/acp-errors'
import { MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS } from '../../native-chat/agent-session-journal/item-lifecycle/journal-prompt-body-bounds'
import {
  pendingAcpResolution,
  type AcpDialect,
  type AcpRequestPresentation,
  type AcpRequestSettlement
} from './acp-dialect'

const ASK_QUESTION = 'cursor/ask_question'
const CREATE_PLAN = 'cursor/create_plan'
// Reports Cursor sends as requests; it ignores the reply, and plan updates already carry the todos.
const REPORTS = ['cursor/update_todos', 'cursor/task', 'cursor/generate_image']
// A refused question comes back as a permission request whose answers are all allow_once.
const QUESTION_FALLBACK_SKIP = '__ask_question_skip__'

const questionRequestSchema = z.object({
  title: z.string().nullish(),
  questions: z
    .array(
      z.object({
        id: z.string(),
        prompt: z.string(),
        allowMultiple: z.boolean().nullish(),
        options: z.array(z.object({ id: z.string(), label: z.string() })).min(1)
      })
    )
    .min(1)
})
const planRequestSchema = z.object({ plan: z.string().nullish(), overview: z.string().nullish() })

function questionRequest(params: unknown): AcpRequestPresentation {
  const parsed = questionRequestSchema.safeParse(params)
  if (!parsed.success) {
    throw new AcpRpcError(-32602, 'Invalid agent question request')
  }
  const questions = parsed.data.questions.map((question) => ({
    id: question.id,
    question: question.prompt,
    multiSelect: question.allowMultiple ?? false,
    options: question.options
  }))
  const body = {
    kind: 'question' as const,
    question: questions[0]!.question,
    options: questions[0]!.options,
    questions,
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
      if (!answers || !isValidAgentSessionQuestionAnswers(questions, answers)) {
        throw new AcpRpcError(-32602, 'Question answer must answer every offered question')
      }
      return {
        outcome: {
          outcome: 'answered',
          answers: answers.map((answer) => ({
            questionId: answer.questionId,
            selectedOptionIds: answer.optionIds
          }))
        }
      }
    }
  }
}

// Shown as a question, so Full access never picks the first answer for the person.
function fallbackQuestionRequest(params: unknown): AcpRequestPresentation | undefined {
  const request = readAcpPermissionRequest(params, () => {})
  if (!request?.options.some((option) => option.optionId === QUESTION_FALLBACK_SKIP)) {
    return undefined
  }
  // The title is the group's; the question itself is the text content.
  const text = request.toolCall.content?.find(
    (block) => block.type === 'content' && block.content.type === 'text'
  )
  const question =
    (text?.type === 'content' && text.content.type === 'text' ? text.content.text : null) ??
    request.toolCall.title ??
    'The agent has a question'
  const options = request.options.map((option) => ({ id: option.optionId, label: option.name }))
  return {
    body: { kind: 'question', question, options, resolution: pendingAcpResolution },
    reply: (response) => {
      if (response === null) {
        return { outcome: { outcome: 'cancelled' } }
      }
      const optionId =
        response.kind === 'option' ? response.optionId : response.answers[0]?.optionIds[0]
      if (!options.some((option) => option.id === optionId)) {
        throw new AcpRpcError(-32602, 'Question answer must select an offered option')
      }
      return { outcome: { outcome: 'selected', optionId } }
    }
  }
}

const TOO_MANY_QUESTIONS = `Orca shows at most ${MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS} questions at once; ask again with at most ${MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS}.`

function settleRequest(method: string, params: unknown): AcpRequestSettlement | undefined {
  if (REPORTS.includes(method)) {
    return { reply: {} }
  }
  // A card keeps only so many questions; any error would make Cursor drop multi-select ones.
  if (
    method === ASK_QUESTION &&
    (questionRequestSchema.safeParse(params).data?.questions.length ?? 0) >
      MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS
  ) {
    return { reply: { outcome: { outcome: 'skipped', reason: TOO_MANY_QUESTIONS } } }
  }
  if (method !== CREATE_PLAN) {
    return undefined
  }
  const parsed = planRequestSchema.safeParse(params)
  if (!parsed.success) {
    throw new AcpRpcError(-32602, 'Invalid agent plan request')
  }
  // Accepting saves Cursor's plan file and ends the turn; building waits for the next message.
  return {
    reply: { outcome: { outcome: 'accepted' } },
    plan:
      parsed.data.plan?.trim() ||
      parsed.data.overview?.trim() ||
      'The agent finished planning without writing a plan.'
  }
}

const NEW_FILE_OLD_TEXT = '-- /dev/null'
const NEW_FILE_HEADER = /^\+\+ b\/[^\n]*\n?/u

// New files arrive as `-- /dev/null` and a `++ b/<path>` line ahead of the content.
function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  if (
    !update.content?.some((block) => block.type === 'diff' && block.oldText === NEW_FILE_OLD_TEXT)
  ) {
    return update
  }
  return {
    ...update,
    content: update.content.map((block) =>
      block.type === 'diff' && block.oldText === NEW_FILE_OLD_TEXT
        ? { ...block, oldText: null, newText: block.newText.replace(NEW_FILE_HEADER, '') }
        : block
    )
  }
}

export const CURSOR_ACP_DIALECT: AcpDialect = {
  // Model, effort and fast arrive as separate options instead of one selector per variant.
  clientCapabilities: { _meta: { parameterizedModelPicker: true } },
  fastConfigId: 'fast',
  sessionlessRequests: [ASK_QUESTION, CREATE_PLAN, ...REPORTS],
  request: (method, params) =>
    method === ASK_QUESTION
      ? questionRequest(params)
      : method === 'session/request_permission'
        ? fallbackQuestionRequest(params)
        : undefined,
  settleRequest,
  normalizeToolUpdate
}
