import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const COMPUTER_FLAGS = [...GLOBAL_FLAGS, 'worktree', 'session', 'app']
const COMPUTER_WINDOW_TARGET_FLAGS = ['window-id', 'window-index']
const COMPUTER_ACTION_FLAGS = [
  ...COMPUTER_FLAGS,
  ...COMPUTER_WINDOW_TARGET_FLAGS,
  'restore-window',
  'no-screenshot'
]

export const COMPUTER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['computer', 'capabilities'],
    summary: 'Show computer-use provider capabilities',
    usage: 'orca computer capabilities [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['computer', 'list-apps'],
    summary: 'List running apps available to computer-use',
    usage: 'orca computer list-apps [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['computer', 'permissions'],
    summary: 'Open computer-use permission setup',
    usage: 'orca computer permissions [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['computer', 'list-windows'],
    summary: 'List windows for an app available to computer-use',
    usage:
      'orca computer list-windows --app <name|bundle|pid:N> [--worktree <selector> | --session <id>] [--json]',
    allowedFlags: COMPUTER_FLAGS
  },
  {
    path: ['computer', 'get-app-state'],
    summary: 'Capture a compact accessibility snapshot of an app',
    usage:
      'orca computer get-app-state --app <name|bundle|pid:N> [--window-id <id> | --window-index <n>] [--worktree <selector> | --session <id>] [--restore-window] [--no-screenshot] [--json]',
    allowedFlags: [...COMPUTER_ACTION_FLAGS, ...COMPUTER_WINDOW_TARGET_FLAGS, 'restore-window']
  },
  {
    path: ['computer', 'click'],
    summary: 'Click an app element or window coordinate',
    usage:
      'orca computer click --app <app> (--element-index <n> | --x <x> --y <y>) [--window-id <id> | --window-index <n>] [--click-count <n>] [--mouse-button <left|right|middle>] [--restore-window] [--no-screenshot] [--json]',
    allowedFlags: [
      ...COMPUTER_ACTION_FLAGS,
      'element-index',
      'x',
      'y',
      'click-count',
      'mouse-button'
    ]
  },
  {
    path: ['computer', 'perform-secondary-action'],
    summary: 'Perform an advertised secondary accessibility action',
    usage:
      'orca computer perform-secondary-action --app <app> --element-index <n> --action <name> [--window-id <id> | --window-index <n>] [--restore-window] [--no-screenshot] [--json]',
    allowedFlags: [...COMPUTER_ACTION_FLAGS, 'element-index', 'action']
  },
  {
    path: ['computer', 'scroll'],
    summary: 'Scroll an app element or window coordinate',
    usage:
      'orca computer scroll --app <app> (--element-index <n> | --x <x> --y <y>) --direction <up|down|left|right> [--window-id <id> | --window-index <n>] [--pages <n>] [--restore-window] [--no-screenshot] [--json]',
    allowedFlags: [...COMPUTER_ACTION_FLAGS, 'element-index', 'x', 'y', 'direction', 'pages']
  },
  {
    path: ['computer', 'drag'],
    summary: 'Drag between app elements or window coordinates',
    usage:
      'orca computer drag --app <app> (--from-element-index <n> --to-element-index <n> | --from-x <x> --from-y <y> --to-x <x> --to-y <y>) [--window-id <id> | --window-index <n>] [--restore-window] [--no-screenshot] [--json]',
    allowedFlags: [
      ...COMPUTER_ACTION_FLAGS,
      'from-element-index',
      'to-element-index',
      'from-x',
      'from-y',
      'to-x',
      'to-y'
    ]
  },
  {
    path: ['computer', 'type-text'],
    summary: 'Type literal text at the current app focus',
    usage:
      'orca computer type-text --app <app> (--text <text> | --text-stdin) [--window-id <id> | --window-index <n>] [--restore-window] [--no-screenshot] [--json]',
    allowedFlags: [...COMPUTER_ACTION_FLAGS, 'text', 'text-stdin']
  },
  {
    path: ['computer', 'press-key'],
    summary: 'Press a key using xdotool-style syntax',
    usage:
      'orca computer press-key --app <app> --key <key> [--window-id <id> | --window-index <n>] [--restore-window] [--no-screenshot] [--json]',
    allowedFlags: [...COMPUTER_ACTION_FLAGS, 'key']
  },
  {
    path: ['computer', 'hotkey'],
    summary: 'Press a platform-aware key combination',
    usage:
      'orca computer hotkey --app <app> --key <key-combo> [--window-id <id> | --window-index <n>] [--restore-window] [--no-screenshot] [--json]',
    allowedFlags: [...COMPUTER_ACTION_FLAGS, 'key']
  },
  {
    path: ['computer', 'paste-text'],
    summary: 'Paste exact text at the current app focus',
    usage:
      'orca computer paste-text --app <app> (--text <text> | --text-stdin) [--window-id <id> | --window-index <n>] [--restore-window] [--no-screenshot] [--json]',
    allowedFlags: [...COMPUTER_ACTION_FLAGS, 'text', 'text-stdin']
  },
  {
    path: ['computer', 'set-value'],
    summary: 'Set the value of a settable app element',
    usage:
      'orca computer set-value --app <app> --element-index <n> (--value <text> | --value-stdin) [--window-id <id> | --window-index <n>] [--restore-window] [--no-screenshot] [--json]',
    allowedFlags: [...COMPUTER_ACTION_FLAGS, 'element-index', 'value', 'value-stdin']
  }
]
