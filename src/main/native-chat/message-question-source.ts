import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  asyncQuestionOccurrenceId,
  asyncQuestionSourceScope,
  type AsyncQuestionContributor
} from '../../shared/native-chat/input/native-chat-ask'

export const messageQuestionSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('structured'), sessionId: z.string(), agent: z.string() }),
  z.strictObject({
    kind: z.literal('transcript'),
    sessionId: z.string(),
    agent: z.string(),
    filePath: z.string()
  })
])
export type MessageQuestionSource = z.infer<typeof messageQuestionSourceSchema>

export const messageQuestionSourceStateSchema = z.strictObject({
  generation: z.string(),
  file: z
    .strictObject({
      identity: z.string(),
      size: z.number(),
      mtimeMs: z.number(),
      ctimeMs: z.number(),
      offset: z.number(),
      boundary: z.string()
    })
    .nullable()
})
export type MessageQuestionSourceState = z.infer<typeof messageQuestionSourceStateSchema>

function identity(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export function messageQuestionSourceId(source: MessageQuestionSource): string {
  return `message-question-source:${identity([source.kind, source.agent, source.sessionId, source.kind === 'transcript' ? source.filePath : null])}`
}

export function messageQuestionOccurrenceId(
  source: MessageQuestionSource,
  context: string,
  contributor: AsyncQuestionContributor
): string {
  const scope = asyncQuestionSourceScope(
    source.kind === 'structured'
      ? { kind: 'journal', agent: source.agent, sessionId: source.sessionId, epoch: context }
      : {
          kind: 'transcript',
          agent: source.agent,
          sessionId: source.sessionId,
          transcriptPath: source.filePath
        }
  )
  return asyncQuestionOccurrenceId(
    source.kind === 'structured' ? scope : JSON.stringify([scope, context]),
    contributor
  )
}
