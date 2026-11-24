import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { OrchestrationMessageSummary } from '../../../shared/orchestration/mailbox/orchestration-check-output'
import { readTextOrFileFlag } from '../../arguments/command-body-input'
import { getRequiredStringFlag } from '../../arguments/flags'
import type { HandlerContext } from '../../dispatch/dispatch'
import { RuntimeClientError } from '../../runtime/connection/types'

const Preference = z
  .strictObject({
    runId: z.string().min(1),
    taskId: z.string().min(1),
    question: z.string().min(1),
    options: z.array(z.string().min(1)).min(1),
    answer: z.string().min(1)
  })
  .refine((rule) => rule.options.includes(rule.answer), 'Each answer must name a listed choice.')
const Policy = z.strictObject({ version: z.literal(1), preferences: z.array(Preference) })
const Asked = z.strictObject({
  taskId: z.string().min(1),
  dispatchId: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.string())
})

type ThreadMessage = OrchestrationMessageSummary & { thread_id?: string | null }

export async function readOrchestrationReplyBody(
  { flags, cwd, client }: HandlerContext,
  id: string
): Promise<string | undefined> {
  if (!flags.has('preference-file')) {
    return readTextOrFileFlag(flags, cwd, 'body', true)
  }
  if (flags.has('body') || flags.has('body-file')) {
    throw new RuntimeClientError('invalid_argument', 'Choose one reply source.')
  }
  const run = getRequiredStringFlag(flags, 'run')
  const path = resolve(cwd, getRequiredStringFlag(flags, 'preference-file'))
  const policy = Policy.parse(JSON.parse(await readFile(path, 'utf8')))
  const { result } = await client.call<{ messages: ThreadMessage[] }>('orchestration.inbox', {
    run,
    terminal: `run:${run}`,
    limit: 1000
  })
  const message = result.messages.find((row) => row.id === id)
  if (
    !message ||
    message.type !== 'question' ||
    message.delivery_contract !== 'current_delivery' ||
    message.run_id !== run ||
    message.to_handle !== `run:${run}` ||
    message.thread_id !== id ||
    !message.payload
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Expected a current worker question in this Run.'
    )
  }
  const asked = Asked.parse(JSON.parse(message.payload))
  if (message.from_handle !== `dispatch:${asked.dispatchId}` || message.body !== asked.question) {
    throw new RuntimeClientError('invalid_argument', 'The question does not match its Dispatch.')
  }
  const matches = policy.preferences.filter(
    (choice) =>
      choice.runId === run &&
      choice.taskId === asked.taskId &&
      choice.question === asked.question &&
      isDeepStrictEqual(choice.options, asked.options)
  )
  if (matches.length !== 1) {
    throw new RuntimeClientError('invalid_argument', 'This question needs an explicit decision.')
  }
  return matches[0].answer
}
