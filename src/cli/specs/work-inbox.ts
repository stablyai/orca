import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const WORK_INBOX_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['inbox', 'mcp'],
    summary: 'Serve human Work Inbox question tools over MCP stdio',
    usage: 'orca inbox mcp',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Run as an MCP server inside an Orca agent terminal; inherit the identity injected by Orca.',
      'Exposes ask_user, wait_for_answer and acknowledge_answer. Human answers are entered in Orca Work Inbox; no answer tool is exposed.',
      'Use immutable request IDs, resume the same question after a timeout, and continue only after an answer.'
    ]
  }
]
