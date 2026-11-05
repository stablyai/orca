import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const CHAT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['chat', 'list'],
    summary: 'List agent chats with their workspace, state and last reply',
    usage: 'orca chat list [--worktree <name-or-id>] [--state <state>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'state'],
    notes: [
      'Lists the top-level chats Orca shows as agent tabs. Terminal agents are read with `orca terminal`.',
      '--state keeps chats in one state, such as working, done, blocked or waiting.'
    ],
    examples: ['orca chat list --json', 'orca chat list --state working']
  },
  {
    path: ['chat', 'read'],
    summary: 'Read the latest messages of an agent chat',
    usage: 'orca chat read --session <id-or-handle> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'limit'],
    notes: [
      '--session takes the session id or handle from `orca chat list` or `orca agent launch`.',
      '--limit is the number of entries shown (messages, tool calls, approvals and questions); the default is 20 and the maximum 100.',
      'Approvals and questions waiting for an answer are marked "waiting for you".'
    ],
    examples: ['orca chat read --session codex_1234 --limit 10']
  },
  {
    path: ['chat', 'send'],
    summary: 'Send a message to an agent chat',
    usage: 'orca chat send --session <id-or-handle> --text <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'text'],
    notes: [
      'Sends the text as your message, as if typed in the chat.',
      'While the agent is working, hosts with a message queue hold the message until the turn ends; the result says "queued".',
      'A chat that restarted since it was read refuses the send; read it again and resend.'
    ],
    examples: [
      'orca chat send --session codex_1234 --text "Run the tests, then summarize failures"'
    ]
  }
]
