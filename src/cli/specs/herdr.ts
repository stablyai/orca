import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const HERDR_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['herdr', 'daemon'],
    summary: 'Start the herdr multiplexer daemon (internal use)',
    usage: 'orca herdr daemon [--socket <path>] [--foreground]',
    allowedFlags: [...GLOBAL_FLAGS, 'socket', 'foreground'],
    notes: [
      'This command is used internally by Orca to start the herdr multiplexer daemon. It manages all terminal PTYs (local, SSH, remote) and agent sessions.'
    ]
  },
  {
    path: ['herdr', 'session', 'list'],
    summary: 'List active herdr sessions',
    usage: 'orca herdr session list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['herdr', 'pane', 'create'],
    summary: 'Create a new pane in herdr (internal use)',
    usage:
      'orca herdr pane create --project <id> --workspace <id> --tab <id> --leaf <id> --cols <n> --rows <n> [--cwd <path>] [--command <cmd>]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'project',
      'workspace',
      'tab',
      'leaf',
      'cols',
      'rows',
      'cwd',
      'command'
    ]
  },
  {
    path: ['herdr', 'pane', 'split'],
    summary: 'Split a herdr pane (internal use)',
    usage: 'orca herdr pane split --pane <id> --direction <right|down> [--ratio <float>]',
    allowedFlags: [...GLOBAL_FLAGS, 'pane', 'direction', 'ratio']
  },
  {
    path: ['herdr', 'pane', 'resize'],
    summary: 'Resize a herdr pane (internal use)',
    usage: 'orca herdr pane resize --pane <id> --cols <n> --rows <n>',
    allowedFlags: [...GLOBAL_FLAGS, 'pane', 'cols', 'rows']
  },
  {
    path: ['herdr', 'pane', 'close'],
    summary: 'Close a herdr pane (internal use)',
    usage: 'orca herdr pane close --pane <id>',
    allowedFlags: [...GLOBAL_FLAGS, 'pane']
  },
  {
    path: ['herdr', 'pane', 'send-keys'],
    summary: 'Send keys to a herdr pane (internal use)',
    usage: 'orca herdr pane send-keys --pane <id> --keys <key>...',
    allowedFlags: [...GLOBAL_FLAGS, 'pane', 'keys']
  }
]
