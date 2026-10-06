import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { expect } from 'vitest'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  legacyAgentSessionSelectedOptionId,
  type AgentSessionPromptResponse
} from '../../shared/agent-session-question-answer'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { openProviderTimelineRig } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import type { AcpRequestPresentation } from './acp-dialects/acp-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'
import { PromptResponseSchema } from './generated/acp-protocol.generated'

const frameSchema = z.object({
  direction: z.enum(['in', 'out']),
  process: z.string(),
  message: z.object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional()
  })
})
export type AcpFixtureFrame = z.infer<typeof frameSchema>
const replySchema = z.object({
  outcome: z.union([
    z.string(),
    z.object({ outcome: z.string(), optionId: z.string().optional() })
  ]),
  answers: z.record(z.string(), z.string()).optional()
})

export async function readAcpFixture(name: string): Promise<AcpFixtureFrame[]> {
  const text = await readFile(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8')
  return text
    .trim()
    .split('\n')
    .map((line) => frameSchema.parse(JSON.parse(line)))
}

function fixtureAnswer(
  presentation: AcpRequestPresentation,
  result: unknown
): AgentSessionPromptResponse | null {
  const reply = replySchema.parse(result)
  if (typeof reply.outcome === 'object') {
    return reply.outcome.optionId ? { kind: 'option', optionId: reply.outcome.optionId } : null
  }
  if (presentation.body.kind === 'approval') {
    return { kind: 'option', optionId: reply.outcome }
  }
  return {
    kind: 'answers',
    answers: (presentation.body.questions ?? []).map((question) => {
      const value = reply.answers?.[question.question]
      return {
        questionId: question.id,
        optionIds: question.options
          .filter((option) => option.label === value)
          .map((option) => option.id)
      }
    })
  }
}

/** Captured frames go through translation, assembly and the real serialized journal. */
export async function openAcpFixtureRig() {
  const rig = await openProviderTimelineRig()
  let providerSessionId = 'session-1'
  const translator = () =>
    new AcpTimelineTranslator({ sessionId: providerSessionId, dialect: GROK_ACP_DIALECT })
  let lane = translator()
  const requests = new Map<
    string | number,
    { request: string; presentation: AcpRequestPresentation }
  >()
  const apply = (events: ProviderTimelineEvent[]) => {
    for (const event of events) {
      expect(rig.assembler.apply(event).admission.accepted).toBe(true)
    }
  }
  const feed = async (frames: AcpFixtureFrame[]) => {
    for (const [index, frame] of frames.entries()) {
      const { message, direction } = frame
      const at = 1000 + index
      if (direction === 'out' && message.method === 'session/load') {
        lane.beginLoad()
      } else if (direction === 'out' && message.method === 'session/prompt') {
        const session = z.object({ sessionId: z.string() }).parse(message.params)
        if (providerSessionId !== session.sessionId) {
          providerSessionId = session.sessionId
          lane = translator()
        }
        apply(lane.openPrompt(`${frame.process}:${message.id}`, at).events)
      } else if (direction === 'in' && message.method && message.id !== undefined) {
        const request = lane.request(message.method, message.params, message.id)
        apply(request.events)
        const opened = request.events.find((event) => event.type === 'request.open')
        if (opened && request.presentation) {
          requests.set(message.id, { request: opened.request, presentation: request.presentation })
        }
      } else if (direction === 'out' && message.id !== undefined && !message.method) {
        const request = requests.get(message.id)
        if (!request) {
          continue
        }
        const response = fixtureAnswer(request.presentation, message.result)
        expect(request.presentation.reply(response)).toEqual(message.result)
        const row = (await rig.rows()).find(
          (item) =>
            item.body.kind === request.presentation.body.kind &&
            (item.body.kind === 'approval' || item.body.kind === 'question') &&
            item.body.resolution.state === 'pending'
        )
        const identity = row ? parseAgentJournalItemKey(row.itemId) : null
        if (!row || !identity || (row.body.kind !== 'approval' && row.body.kind !== 'question')) {
          throw new Error('Missing request row')
        }
        await rig.journal.appendItem(
          identity,
          {
            ...row.body,
            resolution: {
              state: response ? 'resolved' : 'cancelled',
              selectedOptionId:
                response?.kind === 'option'
                  ? response.optionId
                  : row.body.kind === 'question' && response?.kind === 'answers'
                    ? legacyAgentSessionSelectedOptionId(row.body, response.answers)
                    : null,
              ...(response?.kind === 'answers' ? { answers: response.answers } : {}),
              resolvedBy: 'fixture-client',
              resolvedAt: at
            }
          },
          { fence: 1, turnScope: row.turnScope ?? { kind: 'thread' } }
        )
        requests.delete(message.id)
      } else if (direction === 'in' && message.method) {
        apply(lane.notification(message.method, message.params, at))
      } else if (direction === 'in') {
        const models = z.object({ models: z.unknown() }).safeParse(message.result)
        if (models.success) {
          apply(lane.contextModels(models.data.models, at))
        }
        const result = PromptResponseSchema.safeParse(message.result)
        if (result.success) {
          apply(lane.promptResult(`${frame.process}:${message.id}`, result.data, at))
        }
      }
    }
    return rig.rows()
  }
  return {
    rig,
    apply,
    feed,
    lane: () => lane,
    /** A new provider child: the sweep, a new generation's assembler and a new translator. */
    restart: async () => {
      await rig.restart()
      lane = translator()
    },
    finishLoad: () => lane.finishLoad()
  }
}
