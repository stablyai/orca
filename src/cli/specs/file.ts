import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const FILE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['file', 'open'],
    summary: 'Show a workspace file to the user in the Orca editor',
    usage: 'orca file open <path> [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path', 'worktree'],
    positionalArgs: ['path'],
    notes: [
      'Switches the Orca window to the target worktree and shows the result, interrupting whatever the user is doing. Run it only when the user asked to see it; never to display your own output.',
      'The path may be relative to the selected worktree or an absolute path inside that worktree. When --worktree is omitted, local CLI calls infer the current Orca worktree from cwd.'
    ],
    examples: [
      'orca file open src/App.tsx',
      'orca file open --path docs/readme.md --worktree active'
    ]
  },
  {
    path: ['file', 'diff'],
    summary: 'Show a workspace file diff to the user in the Orca editor',
    usage: 'orca file diff <path> [--staged] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path', 'staged', 'worktree'],
    positionalArgs: ['path'],
    notes: [
      'Switches the Orca window to the target worktree and shows the result, interrupting whatever the user is doing. Run it only when the user asked to see it; never to display your own output.',
      'Diffs default to unstaged changes. Pass --staged to open the staged source-control diff.',
      'The path may be relative to the selected worktree or an absolute path inside that worktree.'
    ],
    examples: [
      'orca file diff src/App.tsx',
      'orca file diff --path package.json --staged --worktree branch:feature'
    ]
  },
  {
    path: ['file', 'open-changed'],
    summary: 'Show all git-changed files for a workspace to the user',
    usage: 'orca file open-changed [--mode edit|diff|both] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'mode', 'worktree'],
    notes: [
      'Switches the Orca window to the target worktree and shows the result, interrupting whatever the user is doing. Run it only when the user asked to see it; never to display your own output.',
      'For v1, changed files come from git status for the selected worktree.',
      'The default mode is diff. Edit mode skips deleted files because there is no file to open.'
    ],
    examples: [
      'orca file open-changed',
      'orca file open-changed --mode both',
      'orca file open-changed --mode diff --worktree active'
    ]
  }
]
