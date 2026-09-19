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
import { callOrchestrationMutation } from './mutation-request'
import { resolveOrchestrationTerminalHandle } from './terminal-identity'
import { RuntimeClientError } from '../../runtime-client'

type InboxResult = {
  messages: MessageSummary[]
  count: number
  scope?: string
  runBinding?: string | null
}

export const ORCHESTRATION_INBOX_HANDLERS: Record<string, CommandHandler> = {
  'orchestration reply': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await callOrchestrationMutation<{ message: { id: string } }>(
      client,
      flags,
      'orchestration.reply',
      {
        id: getRequiredStringFlag(flags, 'id'),
        body: getRequiredStringFlag(flags, 'body'),
        run: getOptionalStringFlag(flags, 'run'),
        from
      }
    )
    printResult(result, json, (value) => `Replied ${value.message.id}`)
  },

  'orchestration inbox': async ({ flags, client, cwd, json }) => {
    const full = flags.has('full')
    const run = getOptionalStringFlag(flags, 'run')
    const explicitTerminal = getOptionalStringFlag(flags, 'terminal')
    const terminal = run
      ? await resolveOrchestrationTerminalHandle(flags, cwd, client, 'terminal')
      : explicitTerminal
    const result = await client.call<InboxResult>('orchestration.inbox', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
      terminal,
      terminalPaneKey:
        run && !explicitTerminal ? process.env.ORCA_PANE_KEY || undefined : undefined,
      run
    })
    if (run && result.result.scope !== `messages addressed to Run ${run}`) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'The running Orca runtime does not support Run-scoped inbox reads. Update or restart Orca and try again.'
      )
    }
    printResult(result, json, (value) => {
      if (value.count === 0) {
        if (value.scope) {
          const binding = value.runBinding ? ` Current Run binding: ${value.runBinding}.` : ''
          return `No ${value.scope}.${binding}`
        }
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
