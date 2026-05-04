import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const BROWSER_BASIC_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['snapshot'],
    summary: 'Capture an accessibility snapshot of the active browser tab',
    usage: 'orca snapshot [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['screenshot'],
    summary: 'Capture a viewport screenshot of the active browser tab',
    usage: 'orca screenshot [--format <png|jpeg>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'format', 'worktree']
  },
  {
    path: ['click'],
    summary: 'Click a browser element by ref',
    usage: 'orca click --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['fill'],
    summary: 'Clear and fill a browser input by ref',
    usage: 'orca fill --element <ref> --value <text> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'value', 'worktree']
  },
  {
    path: ['type'],
    summary: 'Type text at the current browser focus',
    usage: 'orca type --input <text> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'input', 'worktree']
  },
  {
    path: ['select'],
    summary: 'Select a dropdown option by ref',
    usage: 'orca select --element <ref> --value <value> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'value', 'worktree']
  },
  {
    path: ['scroll'],
    summary: 'Scroll the browser viewport',
    usage: 'orca scroll --direction <up|down> [--amount <pixels>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'direction', 'amount', 'worktree']
  },
  {
    path: ['goto'],
    summary: 'Navigate the active browser tab to a URL',
    usage: 'orca goto --url <url> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'url', 'worktree']
  },
  {
    path: ['back'],
    summary: 'Navigate back in browser history',
    usage: 'orca back [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['reload'],
    summary: 'Reload the active browser tab',
    usage: 'orca reload [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['eval'],
    summary: 'Evaluate JavaScript in the browser page context',
    usage: 'orca eval --expression <js> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'expression', 'worktree']
  },
  {
    path: ['wait'],
    summary: 'Wait for element, text, URL, load state, JS condition, or timeout',
    usage:
      'orca wait [--selector <sel>] [--timeout <ms>] [--text <text>] [--url <pattern>] [--load <state>] [--fn <js>] [--state <hidden|visible>] [--worktree <selector>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'selector',
      'timeout',
      'text',
      'url',
      'load',
      'fn',
      'state',
      'worktree'
    ]
  },
  {
    path: ['check'],
    summary: 'Check a checkbox/radio by ref',
    usage: 'orca check --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['uncheck'],
    summary: 'Uncheck a checkbox/radio by ref',
    usage: 'orca uncheck --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['focus'],
    summary: 'Focus a browser element by ref',
    usage: 'orca focus --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['clear'],
    summary: 'Clear an input element by ref',
    usage: 'orca clear --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['select-all'],
    summary: 'Select all text in an input by ref',
    usage: 'orca select-all --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['keypress'],
    summary: 'Press a key (Enter, Tab, Escape, ArrowDown, etc.)',
    usage: 'orca keypress --key <name> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key', 'worktree']
  },
  {
    path: ['pdf'],
    summary: 'Export the active browser tab as PDF',
    usage: 'orca pdf [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['full-screenshot'],
    summary: 'Capture a full-page screenshot (beyond viewport)',
    usage: 'orca full-screenshot [--format <png|jpeg>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'format', 'worktree']
  },
  {
    path: ['hover'],
    summary: 'Hover over a browser element by ref',
    usage: 'orca hover --element <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'worktree']
  },
  {
    path: ['drag'],
    summary: 'Drag from one element to another',
    usage: 'orca drag --from <ref> --to <ref> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'from', 'to', 'worktree']
  },
  {
    path: ['upload'],
    summary: 'Upload files to a file input element',
    usage: 'orca upload --element <ref> --files <path,...> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'element', 'files', 'worktree']
  },
  {
    path: ['tab', 'list'],
    summary: 'List open browser tabs',
    usage: 'orca tab list [--worktree <selector|all>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['tab', 'switch'],
    summary: 'Switch the active browser tab',
    usage: 'orca tab switch (--index <n> | --page <id>) [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'index', 'worktree']
  },
  {
    path: ['tab', 'create'],
    summary: 'Create a new browser tab in the current worktree',
    usage: 'orca tab create [--url <url>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'url', 'worktree']
  },
  {
    path: ['tab', 'close'],
    summary: 'Close a browser tab',
    usage: 'orca tab close [--index <n>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'index', 'worktree']
  },
  {
    path: ['exec'],
    summary: 'Run any agent-browser command against the active browser tab',
    usage: 'orca exec --command "<agent-browser command>" [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'command', 'worktree']
  }
]
