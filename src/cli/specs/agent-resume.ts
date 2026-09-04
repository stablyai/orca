import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_RESUME_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'resume-env'],
    hidden: true,
    summary: 'Launch a restored agent session from protected environment arguments',
    usage: 'orca agent resume-env',
    allowedFlags: [...GLOBAL_FLAGS]
  }
]
