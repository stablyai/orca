import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SKILLS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['skills', 'link'],
    summary:
      "Symlink this Orca checkout's skills/ into ~/.agents/skills for local agent development",
    usage: 'orca skills link [--repo <path>] [--force] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'force'],
    examples: [
      'orca skills link',
      'orca skills link --repo /path/to/stablyai-orca',
      'orca skills link --force'
    ],
    notes: [
      'Creates one symlink per top-level skill dir: ~/.agents/skills/<name> -> <repo>/skills/<name>.',
      'Refuses to run unless <repo> is a clone of stablyai/orca (origin remote check).',
      'Idempotent: skips skills whose symlink already points at the repo; --force re-links.'
    ]
  },
  {
    path: ['skills', 'unlink'],
    summary: 'Remove the symlinks created by `orca skills link`',
    usage: 'orca skills unlink [--repo <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo'],
    examples: ['orca skills unlink', 'orca skills unlink --repo /path/to/stablyai-orca'],
    notes: [
      'Only removes symlinks that point back into the given repo. Leaves other ~/.agents/skills entries untouched.'
    ]
  }
]
