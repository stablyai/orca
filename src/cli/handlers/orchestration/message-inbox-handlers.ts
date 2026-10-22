import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../../flags'
import {
  formatMessageReadOnlyTag,
  type OrchestrationMessageSummary as MessageSummary
} from '../../../shared/orchestration-check-output'
import type { QuestionInspectResult } from '../../../shared/orchestration-rpc-contract'
import { callOrchestrationMutation } from './mutation-request'
import { resolveOrchestrationTerminalHandle } from './terminal-identity'

export const ORCHESTRATION_INBOX_HANDLERS: Record<string, CommandHandler> = {
  'orchestration reply': async ({ flags, client, cwd, json }) => {
    const mode = getRequiredStringFlag(flags, 'mode')
    if (mode !== 'question' && mode !== 'message') {
      throw new Error('--mode must be question or message')
    }
    const selector = mode === 'question' ? getRequiredStringFlag : getOptionalStringFlag
    const run = selector(flags, 'run')
    const task = selector(flags, 'task')
    const dispatch = selector(flags, 'dispatch')
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await callOrchestrationMutation<{ message: { id: string } }>(
      client,
      flags,
      mode === 'question' ? 'orchestration.questionReply' : 'orchestration.messageReply',
      {
        id: getRequiredStringFlag(flags, 'id'),
        body: getRequiredStringFlag(flags, 'body'),
        mode,
        run,
        task,
        dispatch,
        from
      }
    )
    printResult(result, json, (value) => `Replied ${value.message.id}`)
  },

  'orchestration question-inspect': async ({ flags, client, json }) => {
    const result = await client.call<QuestionInspectResult>('orchestration.questionInspect', {
      id: getRequiredStringFlag(flags, 'id'),
      run: getRequiredStringFlag(flags, 'run'),
      task: getRequiredStringFlag(flags, 'task'),
      dispatch: getRequiredStringFlag(flags, 'dispatch')
    })
    printResult(result, json, (value) => {
      const question = value.question
      return [
        `${question.message_id} (${question.status})`,
        question.body,
        ...question.options.map((option) => `- ${option}`)
      ].join('\n')
    })
  },

  'orchestration inbox': async ({ flags, client, json }) => {
    const full = flags.has('full')
    const result = await client.call<{
      messages: MessageSummary[]
      count: number
    }>('orchestration.inbox', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
      terminal: getOptionalStringFlag(flags, 'terminal')
    })
    printResult(result, json, (value) => {
      if (value.count === 0) {
        return 'No messages.'
      }
      // Why: default output omits body/payload for at-a-glance sweeps; --full prints them for auditing.
      return value.messages
        .map((message) => {
          const head = `${message.id}${formatMessageReadOnlyTag(message)} ${message.from_handle} -> ${message.to_handle ?? '?'}: "${message.subject}"`
          if (!full) {
            return head
          }
          const parts = [head]
          if (message.body && message.body.length > 0) {
            parts.push(message.body)
          }
          if (message.payload) {
            parts.push(`[payload] ${message.payload}`)
          }
          return parts.join('\n')
        })
        .join(full ? '\n\n' : '\n')
    })
  }
}
