import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['terminal', 'list'],
    summary: 'List live Orca-managed terminals',
    usage:
      'orca terminal list [--worktree <selector>] [--limit <n>] [--include-visual-layouts] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'limit', 'include-visual-layouts'],
    notes: [
      'JSON omits visualLayouts by default; pass --include-visual-layouts when machine-readable tab and pane topology is required.'
    ]
  },
  {
    path: ['terminal', 'show'],
    summary: 'Show terminal metadata and preview',
    usage: 'orca terminal show [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal']
  },
  {
    path: ['terminal', 'read'],
    summary: 'Read bounded terminal output',
    usage: 'orca terminal read [--terminal <handle>] [--cursor <n>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'cursor', 'limit'],
    notes: [
      'Omit --terminal to target the active terminal in the current worktree.',
      'Use --cursor with the nextCursor value from a previous read to get only new output since that read.',
      'Use --limit to request more retained lines for long agent responses; output reports oldestCursor when older lines were dropped.',
      'Useful for capturing the response to a command: read before sending, then read --cursor <prev> after waiting.'
    ],
    examples: [
      'orca terminal read --json',
      'orca terminal read --terminal term_abc123 --cursor 42 --limit 1000 --json'
    ]
  },
  {
    path: ['terminal', 'send'],
    summary: 'Send input to a live terminal',
    usage:
      'orca terminal send [--terminal <handle>] [--text <text>] [--enter] [--interrupt] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'terminal',
      'text',
      'enter',
      'interrupt',
      'submit-timeout-ms',
      'no-submit-retry',
      'no-verdict'
    ],
    notes: [
      'With --text and --enter the result carries submitVerdict: submitted (the agent started a turn with it), queued (accepted, runs after the current turn), pending (the text sits unsubmitted in the composer), or unknown (no trustworthy evidence). A missing verdict is unknown, never success.',
      'On a pending verdict Orca re-sends the submit key once. It never re-types the text, so a partly accepted line cannot become a doubled message. Pass --no-submit-retry to disable that, --no-verdict to skip the wait entirely.'
    ]
  },
  {
    path: ['terminal', 'wait'],
    summary: 'Wait for a terminal condition',
    usage:
      'orca terminal wait [--terminal <handle>] --for exit|tui-idle [--timeout-ms <ms>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'for', 'timeout-ms']
  },
  {
    path: ['terminal', 'stop'],
    summary: 'Stop terminals for a worktree',
    usage: 'orca terminal stop --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['terminal', 'create'],
    summary: 'Create a terminal session in the current worktree',
    usage:
      'orca terminal create [--worktree <selector>] [--title <name>] [--command <text>] [--focus] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'command', 'title', 'focus'],
    notes: [
      'Creates a visible terminal tab without switching focus when possible; falls back to a background handle if the UI cannot adopt it. Pass --focus to switch to it.',
      'Use this, not worktree create, for a fresh agent in the current checkout.'
    ],
    examples: [
      'orca terminal create --json',
      'orca terminal create --worktree active --command "codex" --json',
      'orca terminal create --worktree path:/projects/myapp --title "RUNNER" --command "opencode"',
      'orca terminal create --worktree path:/projects/myapp --command "opencode" --focus'
    ]
  },
  {
    path: ['terminal', 'switch'],
    // Why: `focus` is the legacy verb for this action; keep it working as an
    // alias rather than a duplicate spec + handler registration.
    aliases: [['terminal', 'focus']],
    summary: 'Switch to a terminal tab in the UI',
    usage: 'orca terminal switch [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal'],
    examples: ['orca terminal switch --terminal term_abc123']
  },
  {
    path: ['terminal', 'close'],
    summary: 'Close a terminal pane/session, or its whole tab with --tab',
    usage: 'orca terminal close [--terminal <handle>] [--tab] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'tab'],
    notes: [
      'Without --tab, preserves the existing pane/session close behavior. With --tab, waits until the whole tab is durably removed.'
    ],
    examples: [
      'orca terminal close --terminal term_abc123',
      'orca terminal close --terminal term_abc123 --tab --json'
    ]
  },
  {
    path: ['terminal', 'rename'],
    summary: 'Set or clear the title of a terminal tab',
    usage: 'orca terminal rename [--terminal <handle>] [--title <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'title'],
    notes: ['Omit --title or pass an empty string to reset to the auto-generated title.'],
    examples: [
      'orca terminal rename --terminal term_abc123 --title "RUNNER"',
      'orca terminal rename --terminal term_abc123 --json'
    ]
  },
  {
    path: ['terminal', 'split'],
    summary: 'Split an existing terminal pane',
    usage:
      'orca terminal split [--terminal <handle>] [--direction horizontal|vertical] [--command <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'direction', 'command'],
    examples: [
      'orca terminal split --terminal term_abc123 --direction horizontal --json',
      'orca terminal split --terminal term_abc123 --command "codex"'
    ]
  }
]
