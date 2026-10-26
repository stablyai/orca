import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const ORCHESTRATION_ROOM_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'room-create'],
    summary: 'Create a group chat room',
    usage:
      'orca orchestration room-create --name <name> [--mode admin|everyone] [--notice <text>] [--member <member_id[:name[:admin]]>,...] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'mode', 'notice', 'member'],
    notes: [
      'A member is an Orca session address: orca_session_id:<id>. Pass --member orca_session_id:abc:alice:admin to name her alice and make her the admin.'
    ]
  },
  {
    path: ['orchestration', 'room-list'],
    summary: 'List group chat rooms',
    usage: 'orca orchestration room-list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['orchestration', 'room-show'],
    summary: 'Show one room by id or name',
    usage: 'orca orchestration room-show [--id <id>] [--name <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'name']
  },
  {
    path: ['orchestration', 'room-delete'],
    summary: 'Delete a room and its log',
    usage: 'orca orchestration room-delete --id <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id']
  },
  {
    path: ['orchestration', 'room-add'],
    summary: 'Add a member to a room',
    usage:
      'orca orchestration room-add --id <id> --member-id <member_id> --name <name> [--admin] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'member-id', 'name', 'admin']
  },
  {
    path: ['orchestration', 'room-bot-create'],
    summary: 'Spawn a bot session into a room',
    usage:
      'orca orchestration room-bot-create --id <id> --worktree <selector> --agent <lane> --name <name> [--model <model>] [--effort <effort>] [--admin] [--instructions <text>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'id',
      'worktree',
      'agent',
      'model',
      'effort',
      'name',
      'admin',
      'instructions'
    ]
  },
  {
    path: ['orchestration', 'room-remove'],
    summary: 'Remove a member from a room',
    usage: 'orca orchestration room-remove --id <id> --member-id <member_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'member-id']
  },
  {
    path: ['orchestration', 'room-send'],
    summary: 'Post a user message into a room and run the opening round',
    usage:
      'orca orchestration room-send [--id <id> | --name <name>] --text <text> [--from <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'name', 'text', 'from'],
    notes: [
      'Write "@Name" to call one member; in admin mode only the room admin can "@all". Plain text with no @-mention goes to the admin, or to everyone in everyone mode.'
    ]
  },
  {
    path: ['orchestration', 'room-post'],
    summary: 'Post a member reply into the room (for tests and external drivers)',
    usage: 'orca orchestration room-post --id <id> --member-id <member_id> --text <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'member-id', 'text'],
    notes: [
      'Live rooms normally write replies through the room mailbox (turn-completion watcher). This entry point exists for tests and for a member whose session is driven outside Orca.'
    ]
  },
  {
    path: ['orchestration', 'room-log'],
    summary: 'Read the room transcript',
    usage: 'orca orchestration room-log --id <id> [--member-id <member_id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'member-id']
  },
  {
    path: ['orchestration', 'room-ensure-main-bot'],
    summary: 'Create the HQ room and its admin bot when missing',
    usage:
      'orca orchestration room-ensure-main-bot --worktree <selector> [--agent <lane>] [--model <model>] [--effort <effort>] [--room-name <name>] [--bot-name <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'agent', 'model', 'effort', 'room-name', 'bot-name']
  }
]
