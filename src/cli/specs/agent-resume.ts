import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_RESUME_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'sessions'],
    summary: 'List recorded terminal conversations, including sleeping sessions',
    usage: 'orca agent sessions [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    notes: [
      'Lists only conversations recorded in existing terminal panes on this host. This is not a search of every provider transcript.',
      'connected means a terminal exists, not that its agent is ready. Use the exact paneKey with agent resume.'
    ]
  },
  {
    path: ['agent', 'resume'],
    summary: 'Resume a recorded conversation in its original terminal pane',
    usage:
      'orca agent resume [--worktree <selector>] (--pane <paneKey> | --agent <id> --session <providerSessionId>) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'pane', 'agent', 'session'],
    notes: [
      'Get paneKey and providerSession.id from agent sessions. --agent and --session can also verify the conversation when --pane is supplied.',
      'Keeps the original tab and pane, uses the saved launch recipe, and returns its current handle. Repeated and concurrent requests reuse that pane.',
      'A verified running conversation is adopted. Missing, ambiguous, conflicting or unresumable conversations fail; no fresh agent is substituted.',
      'Runs in the background and sends no prompt. A restore receipt proves startup and terminal identity, not composer readiness; read/wait on the returned terminal before sending work with terminal send.',
      'For a paired server pass --environment and its exact --worktree; no client cwd is used to select a remote workspace. Chats use chat read/send instead.'
    ],
    examples: [
      'orca agent sessions --worktree path:/projects/myapp --json',
      'orca agent resume --pane "tab-id:11111111-1111-4111-8111-111111111111" --json',
      'orca agent resume --agent codex --session <providerSessionId> --worktree path:/projects/myapp --json'
    ]
  }
]
