import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_SESSION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'session', 'start'],
    summary: 'Start an agent session in an existing worktree',
    usage:
      'orca agent session start [--worktree <selector>] [--agent <id>] [--prompt <text>] [--focus] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'agent', 'prompt', 'focus']
  },
  {
    path: ['agent', 'session', 'list'],
    summary: 'List agent sessions with their project and worktree association',
    usage:
      'orca agent session list [--project <id>] [--worktree <selector>] [--state live|history|all] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'worktree', 'state', 'limit']
  },
  {
    path: ['agent', 'session', 'resume'],
    summary: 'Resume an agent session in a worktree from the same project',
    usage: 'orca agent session resume --session <id> [--worktree <selector>] [--focus] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'worktree', 'focus']
  },
  {
    path: ['agent', 'session', 'stop'],
    summary: 'Stop a live agent session without deleting its history',
    usage: 'orca agent session stop --session <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session']
  }
]
