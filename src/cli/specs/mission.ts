import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const MISSION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['mission', 'start'],
    summary: 'Plan and supervise a natural-language subagent mission',
    usage:
      'orca mission start --text <mission> [--agent <agent>] [--worktree <selector>] [--from <handle>] [--json]\n' +
      '  local shorthand: orca-sub "<mission>" [--agent <agent>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'text', 'agent', 'worktree', 'from'],
    notes: [
      'orca-sub is the local natural-language subagent entry and does not replace the system orca executable.',
      'The command stays attached as the Mission supervisor until all tasks finish or the process is cancelled.',
      'An external shell without --from or an Orca terminal identity gets its own background coordinator; unrelated focused terminals are not reused.',
      'Owned coordinators close after settled completion or pre-Run cancellation. Uncertain Run outcomes retain the reported coordinator for recovery; worker terminals are managed separately.',
      'Mission execution reuses orchestration Run/Task/worker and collaboration topology APIs.'
    ]
  }
]
