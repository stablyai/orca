import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const WORK_INBOX_ASK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['inbox', 'ask'],
    summary: 'Ask the human through the Orca Work Inbox and block until answered',
    usage:
      'orca inbox ask (--question <text> | --resume <id>) [--options <csv>] [--no-free-text] [--no-ack] [--request-id <id>] [--timeout-ms <n>] [--from <handle>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'question',
      'resume',
      'options',
      'no-free-text',
      'no-ack',
      'request-id',
      'timeout-ms',
      'from'
    ],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'Works from any agent in an Orca terminal; no orchestration Dispatch is needed.',
      'Waits through host long-poll deadlines by default, prints the answer, confirms its receipt, then exits 0.',
      'With --no-ack, leave the answer pending receipt until the agent runs inbox ack --id <id>.',
      'An explicit --timeout-ms bounds one wait. On timeout or connection loss preserve the question and use --resume <id>, never ask again.'
    ]
  },
  {
    path: ['inbox', 'ack'],
    summary: 'Acknowledge that this agent received its Work Inbox answer',
    usage: 'orca inbox ack --id <id> [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'from'],
    identityFlagRoles: { from: 'caller' }
  }
]
