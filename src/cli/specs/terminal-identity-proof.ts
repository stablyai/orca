import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const TERMINAL_IDENTITY_PROOF_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['terminal', 'identity-proof', 'begin'],
    summary: 'Issue a short-lived proof marker for the current visible terminal',
    usage: 'orca terminal identity-proof begin --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    notes: [
      'The marker must be rendered by the current agent terminal before complete is called.',
      'Proof is scoped to one runtime, worktree, execution host, topology revision, and PTY incarnation.'
    ]
  },
  {
    path: ['terminal', 'identity-proof', 'complete'],
    summary:
      'Prove the visible terminal binding and assign a conflict-free title within authoritative worktree scope',
    usage: 'orca terminal identity-proof complete --challenge <id> --title <agent-name> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'challenge', 'title']
  }
]
