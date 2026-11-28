import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { visit } from 'jsonc-parser'
import { readNodeFileWithinLimit } from '../../shared/file-content/node-bounded-file-reader'
import {
  SLACK_ANSWER_MAX_BYTES,
  SlackAnswerPresentationSchema
} from '../../shared/connectors/slack-answer-presentation'
import { RuntimeClientError } from '../runtime/connection/types'
import { printResult } from '../output/command-result-output'
import type { HandlerContext } from '../dispatch/dispatch'
import { formatReply, type ConnectorReply } from './bot-reply-format'

function parsePresentation(text: string): unknown {
  const objects: Set<string>[] = []
  let invalid = false
  visit(
    text,
    {
      onObjectBegin: () => {
        objects.push(new Set())
      },
      onObjectProperty: (key) => {
        const fields = objects.at(-1)
        invalid ||= fields?.has(key) === true
        fields?.add(key)
      },
      onObjectEnd: () => {
        objects.pop()
      },
      onError: () => {
        invalid = true
      }
    },
    { disallowComments: true }
  )
  return invalid ? undefined : JSON.parse(text)
}

export async function replyWithPresentation(
  { flags, client, json, cwd }: HandlerContext,
  path: string,
  sessionId: string | undefined,
  timeoutMs: number
): Promise<void> {
  if (
    !sessionId ||
    ['text', 'text-file', 'note', 'file', 'choice', 'react', 'leave-thread'].some((flag) =>
      flags.has(flag)
    )
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--presentation-file takes the whole answer in a Slack bot chat. Use it alone or with --prepare-final.'
    )
  }
  const data = await readNodeFileWithinLimit(resolve(cwd, path), SLACK_ANSWER_MAX_BYTES, {
    regularFileOnly: true
  })
    .then(({ buffer }) =>
      parsePresentation(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
    )
    .catch(() => undefined)
  const parsed = SlackAnswerPresentationSchema.safeParse(data)
  if (!parsed.success || !parsed.data.visual) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Give a version 1 presentation with a complete answer and one valid chart or table in a JSON file up to 12 KiB.'
    )
  }
  const params = { sessionId, presentation: parsed.data }
  if (flags.has('prepare-final')) {
    const answer = await client.call<{ text: string }>('connector.prepareSlackAnswer', params)
    printResult(answer, json, ({ text }) => text)
    return
  }
  const answer = await client.call<ConnectorReply>(
    'connector.replySlackAnswer',
    { ...params, replyId: randomUUID() },
    { timeoutMs }
  )
  printResult(answer, json, formatReply)
}
