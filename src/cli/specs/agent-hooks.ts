import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_HOOK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'hooks', 'status'],
    summary: 'Show whether Orca-managed agent status hooks are enabled',
    usage: 'orca agent hooks status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca agent hooks status', 'orca agent hooks status --json']
  },
  {
    path: ['agent', 'hooks', 'off'],
    summary: 'Disable Orca-managed agent status hooks and remove local hook entries',
    usage: 'orca agent hooks off [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca agent hooks off']
  },
  {
    path: ['agent', 'hooks', 'on'],
    summary: 'Enable Orca-managed agent status hooks',
    usage: 'orca agent hooks on [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca agent hooks on']
  },
  {
    path: ['agent', 'label', 'set'],
    summary: "Set a custom sidebar label for an agent's pane",
    usage: 'orca agent label set [--terminal <handle>] --label <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'label'],
    notes: [
      'Targets the active terminal in the current worktree when --terminal is omitted.',
      'The label wins over orchestration display name / task title / prompt in the sidebar.'
    ],
    examples: [
      'orca agent label set --terminal term_abc123 --label "Reset AI"',
      'orca agent label set --label "Frontend" --json'
    ]
  },
  {
    path: ['agent', 'label', 'clear'],
    summary: "Clear the custom sidebar label for an agent's pane",
    usage: 'orca agent label clear [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal'],
    notes: ['Reverts the row to its auto-derived label (display name / task title / prompt).'],
    examples: ['orca agent label clear --terminal term_abc123']
  }
]
