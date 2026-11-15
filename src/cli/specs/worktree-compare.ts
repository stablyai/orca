import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli-argument-boundary'

export const WORKTREE_COMPARE_COMMAND_SPEC: CommandSpec = {
  path: ['worktree', 'compare'],
  repeatableFlags: ['worktree'],
  summary: 'Start an agent that compares worktrees attempting the same task and recommends one',
  usage:
    'orca worktree compare --worktree <selector> --worktree <selector> [--worktree <selector>...] --agent <id> [--task <text>] [--judge-worktree <selector>] [--model <id>] [--effort <level>] [--surface chat|terminal] [--focus] [--retry-launch <operationId>] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'worktree',
    'agent',
    'task',
    'judge-worktree',
    'model',
    'effort',
    'surface',
    'focus',
    'retry-launch'
  ],
  notes: [
    'Repeat --worktree for each candidate, 2 to 8. The agent gets a read-only prompt listing each checkout path, branch and base, and replies with a ranking, a score and reason per candidate, and a recommended winner.',
    'Pair it with `orca worktree create --agents`, which prints this command for the attempts it started.',
    '--task gives the agent the original task. Without it, the agent infers the task from the changes.',
    '--judge-worktree picks the workspace the agent runs in; it defaults to the one containing the current directory, and must be on the same host as the candidates. Remote clients must pass it.',
    'The prompt asks the agent not to edit, commit or delete anything; the candidates stay as they are. Keep the winner and remove the others with `orca worktree rm`.',
    'Launch, --model, --effort, --surface, --focus and --retry-launch behave as in `orca agent launch`.'
  ],
  examples: [
    'orca worktree compare --worktree name:fix-login-claude --worktree name:fix-login-codex --agent claude --json',
    'orca worktree compare --worktree id:<repoId>::<pathA> --worktree id:<repoId>::<pathB> --agent codex --task "Fix the flaky login test" --json'
  ]
}
