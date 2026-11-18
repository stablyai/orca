import { z } from 'zod'
import {
  isValidAgentSessionQuestionAnswers,
  legacyAgentSessionQuestionAnswers,
  type AgentSessionPromptResponse
} from '../../shared/agent-session/requests/prompts/agent-session-question-answer'
import type { ProviderTimelineRequestBody } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { AgentSessionPromptAnswerRejectedError } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { boundJournalPromptText } from '../native-chat/agent-session-journal/item-lifecycle/journal-prompt-body-bounds'
import { traexRecord, traexText } from './traex-protocol'

const questionsSchema = z
  .array(
    z.object({
      id: z.string(),
      question: z.string(),
      header: z.string().optional(),
      multiSelect: z.boolean().optional(),
      options: z
        .array(z.object({ label: z.string(), description: z.string().optional() }))
        .nullish()
    })
  )
  .min(1)
  .max(8)

export const pendingTraexPromptResolution = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const
export const TRAEX_APPROVAL_LABELS: Readonly<Record<string, string>> = {
  accept: 'Allow once',
  acceptForSession: 'Allow for this session',
  decline: 'Deny',
  cancel: 'Stop'
}

export function traexPermissionsReply(permissions: unknown, decision: unknown) {
  const requested = traexRecord(permissions)
  const accepted =
    decision === 'accept' || decision === 'acceptStrict' || decision === 'acceptForSession'
  return {
    permissions: accepted
      ? {
          ...(requested.network != null ? { network: requested.network } : {}),
          ...(requested.fileSystem != null ? { fileSystem: requested.fileSystem } : {})
        }
      : {},
    scope: decision === 'acceptForSession' ? 'session' : 'turn',
    ...(decision === 'acceptStrict' ? { strictAutoReview: true } : {})
  }
}

export function traexMcpApprovalBody(
  params: Record<string, unknown>
): Extract<ProviderTimelineRequestBody, { kind: 'approval' }> | null {
  const meta = traexRecord(params._meta)
  const schema = traexRecord(params.requestedSchema)
  const properties = schema.properties
  const empty =
    params.requestedSchema == null ||
    (schema.type === 'object' &&
      properties !== null &&
      typeof properties === 'object' &&
      !Array.isArray(properties) &&
      Object.keys(properties).length === 0)
  if (
    meta.codex_approval_kind !== 'mcp_tool_call' ||
    params.mode !== 'form' ||
    !empty ||
    typeof params.turnId !== 'string'
  ) {
    return null
  }
  const persist = meta.persist
  const session = persist === 'session' || (Array.isArray(persist) && persist.includes('session'))
  return {
    kind: 'approval',
    title: 'Run MCP tool',
    description: traexText(params.message),
    detail: boundJournalPromptText(
      [
        traexText(params.serverName),
        meta.tool_params === undefined ? null : JSON.stringify(meta.tool_params)
      ]
        .filter(Boolean)
        .join('\n\n')
    ),
    options: [
      { id: 'accept', label: 'Allow once' },
      ...(session ? [{ id: 'acceptForSession', label: 'Allow for this session' }] : []),
      { id: 'cancel', label: 'Cancel' }
    ],
    resolution: pendingTraexPromptResolution
  }
}

export function traexQuestionBody(
  value: unknown
): Extract<ProviderTimelineRequestBody, { kind: 'question' }> {
  const questions = questionsSchema.parse(value).map((question) => ({
    id: question.id,
    question: question.question,
    header: question.header,
    multiSelect: question.multiSelect === true,
    options: (question.options ?? []).map((option, index) => ({
      id: `${index}`,
      label: option.label,
      description: option.description
    })),
    freeTextQuestionId: question.id
  }))
  return {
    kind: 'question',
    question: questions[0]!.question,
    options: [],
    questions,
    resolution: pendingTraexPromptResolution
  }
}

export function traexPromptReply(
  body: ProviderTimelineRequestBody,
  response: AgentSessionPromptResponse | null
): Record<string, unknown> {
  if (body.kind === 'approval') {
    if (response === null) {
      return { decision: 'cancel' }
    }
    const decision = response.kind === 'option' ? response.optionId : undefined
    if (!decision || !body.options.some((option) => option.id === decision)) {
      throw new AgentSessionPromptAnswerRejectedError(
        'Choose an offered TRAE CLI approval decision'
      )
    }
    return { decision }
  }
  if (!response) {
    return { answers: {} }
  }
  const answers =
    response.kind === 'answers'
      ? response.answers
      : legacyAgentSessionQuestionAnswers(body, response.optionId)
  const questions = body.questions ?? []
  if (!answers || !isValidAgentSessionQuestionAnswers(questions, answers)) {
    throw new AgentSessionPromptAnswerRejectedError('Answer every TRAE CLI question')
  }
  return {
    answers: Object.fromEntries(
      answers.map((answer) => {
        const question = questions.find((entry) => entry.id === answer.questionId)!
        return [
          question.id,
          {
            answers: [
              ...answer.optionIds.map(
                (id) => question.options.find((option) => option.id === id)!.label
              ),
              ...(answer.other !== undefined ? [answer.other] : [])
            ]
          }
        ]
      })
    )
  }
}

/** One approval card for the network/file permissions a request needs. */
export function traexPermissionsApprovalBody(
  params: Record<string, unknown>
): Extract<ProviderTimelineRequestBody, { kind: 'approval' }> {
  return {
    kind: 'approval',
    title: 'Grant permissions',
    description:
      traexText(params.reason) ?? 'This request needs additional network or file permissions.',
    detail: traexPermissionsDetail(params.permissions),
    options: [
      { id: 'accept', label: 'Grant for this turn' },
      { id: 'acceptStrict', label: 'Grant with strict auto review' },
      { id: 'acceptForSession', label: 'Grant for this session' },
      { id: 'decline', label: 'Continue without permissions' }
    ],
    resolution: pendingTraexPromptResolution
  }
}

/** Requested network/file permissions as the bounded detail line of an approval card. */
export function traexPermissionsDetail(value: unknown): string | null {
  const permissions = traexRecord(value)
  const network = traexRecord(permissions.network)
  const fileSystem = traexRecord(permissions.fileSystem)
  const paths = (key: 'read' | 'write'): string | null => {
    const entries = fileSystem[key]
    return Array.isArray(entries)
      ? entries.filter((entry): entry is string => typeof entry === 'string').join(', ') || null
      : null
  }
  const lines = [
    network.enabled === true ? 'Network: enabled' : null,
    paths('read') ? `Read: ${paths('read')}` : null,
    paths('write') ? `Write: ${paths('write')}` : null
  ].filter((line): line is string => Boolean(line))
  return lines.length ? boundJournalPromptText(lines.join('\n')) : null
}
