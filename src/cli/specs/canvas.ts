import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const CANVAS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['canvas', 'peers'],
    summary: 'List connected canvas teammates for this agent session',
    usage: 'orca canvas peers --json',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['canvas', 'send'],
    summary: 'Queue a message to a connected canvas agent',
    usage:
      'orca canvas send --canvas <id> --to <nodeId> --body <text> [--kind question|info|request] [--reply-to <messageId>] [--request-id <uuid>] --json',
    allowedFlags: [...GLOBAL_FLAGS, 'canvas', 'to', 'body', 'kind', 'reply-to', 'request-id']
  },
  {
    path: ['canvas', 'inbox'],
    summary: 'Receive this agent’s canvas messages',
    usage: 'orca canvas inbox --canvas <id> --json',
    allowedFlags: [...GLOBAL_FLAGS, 'canvas']
  }
]
