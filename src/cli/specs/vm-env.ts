import type { CommandSpec } from '../discovery/command-spec'
import { LOCAL_COMMAND_FLAGS } from '../arguments/args'

export const VM_ENV_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['vm', 'env', 'doctor'],
    summary: 'Check that this environment can run agents on the workspace',
    usage: 'orca vm env doctor [--path <worktree>] [--run-setup] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'path', 'run-setup'],
    notes: [
      'Runs on the machine you call it from, against the checkout at --path (default: the current directory).',
      'Checks required CLIs (git plus what the repo manifests imply), coding-agent CLIs and their sign-in, that the Git remote is reachable and a dry-run push is authorized, the orca.yaml setup script, and free disk space.',
      'Without --run-setup it only reports whether setup has run here. --run-setup runs scripts.setup again and fails on a nonzero exit; it can take minutes and changes the checkout like a normal setup run.',
      'Exits 1 when any check fails. Warnings keep ok: true, so read every check before calling the environment clean.'
    ],
    examples: [
      'orca vm env doctor',
      'orca vm env doctor --json',
      'orca vm env doctor --path /workspace/repo --run-setup --json'
    ]
  }
]
