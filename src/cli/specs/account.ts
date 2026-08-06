import { GLOBAL_FLAGS, type CommandSpec } from '../args'

// Why: absorbs the deleted `orca accounts` group; adds select/rm and a remote
// device-authorization login path alongside the original local-terminal flow.
export const ACCOUNT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['account', 'add'],
    summary: 'Add a managed Claude or Codex account by signing in locally or on a remote Orca host',
    usage: 'orca account add [--agent claude|codex] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent'],
    notes: [
      'Without --environment/--pairing-code, runs the agent login (`claude login` / `codex login`) in this terminal and imports the captured credentials into the local Orca runtime.',
      'With --environment or --pairing-code, runs the login on that remote Orca host via device authorization instead and streams its output back to this terminal.',
      'Codex always uses device authorization so the browser can complete sign-in from a different machine.',
      '--agent defaults to claude.'
    ],
    examples: [
      'orca account add',
      'orca account add --agent codex',
      'orca account add --agent codex --environment homelab'
    ]
  },
  {
    path: ['account', 'list'],
    summary: 'List managed Claude and Codex accounts and their usage/rate-limit state',
    usage: 'orca account list [--agent claude|codex] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent'],
    notes: [
      'Renders per-account email, active marker, and current usage/rate-limit state.',
      '--agent filters the list to claude or codex; omit it to list both.',
      'Runs against the local Orca runtime by default; pass --environment or --pairing-code to list accounts on that remote host instead.'
    ],
    examples: ['orca account list', 'orca account list --agent codex --json']
  },
  {
    path: ['account', 'select'],
    summary: 'Switch the active managed account for an agent',
    usage: 'orca account select --agent claude|codex --id <accountId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent', 'id'],
    notes: ['--id is a managed account id from `orca account list --json`.'],
    examples: ['orca account select --agent codex --id acc_123']
  },
  {
    path: ['account', 'rm'],
    // Why: 'rm' is the canonical deletion verb (see vocabulary-policy.ts); 'remove'
    // stays reachable as an alias so it satisfies the policy without a rename.
    aliases: [['account', 'remove']],
    destructive: true,
    summary: 'Remove a managed account for an agent',
    usage: 'orca account rm --agent claude|codex --id <accountId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent', 'id'],
    notes: ['--id is a managed account id from `orca account list --json`.'],
    examples: ['orca account rm --agent codex --id acc_123']
  }
]
