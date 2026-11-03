import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_CREATE_COMMAND_SPEC: CommandSpec = {
  path: ['terminal', 'create'],
  summary: 'Create a terminal session in the current worktree',
  usage:
    'orca terminal create [--worktree <selector>] [--title <name>] [--command <text>] [--shell <shell>] [--view-mode chat|terminal] [--command-agent <agent>] [--focus] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'worktree',
    'command',
    'shell',
    'title',
    'focus',
    'view-mode',
    'command-agent'
  ],
  notes: [
    'Creates a visible terminal tab without switching focus when possible; falls back to a background handle if the UI cannot adopt it. Pass --focus to switch to it.',
    'This creates a terminal and runs --command in it. To start an agent, use `orca agent launch` (or `orca worktree create --agent` for a new checkout), which follows your Chat | CLI choice.',
    "--view-mode chat shows the agent that your own --command starts in the Chat UI view, for commands Orca does not build, such as a wrapper script. Name that agent with --command-agent (for example claude or codex). Orca does not rewrite --command; it treats the terminal as that agent's, as it does for agents it starts itself. --view-mode terminal is the default.",
    "Orca refuses --view-mode chat before creating anything when it cannot show the agent as a chat: the agent has no Chat UI support, --command-agent contradicts the agent Orca recognizes in --command, no worktree is selected, or the workspace runs over SSH and Orca can read that agent's transcript only locally. An Orca host older than --view-mode is refused by the CLI.",
    '--shell picks the shell the terminal IS on a Windows host (cmd.exe, powershell.exe, pwsh.exe, wsl.exe, bash.exe, git-bash); --command is typed into whatever shell the host started, so `--command cmd.exe` leaves a cmd running INSIDE the default shell and exiting it drops back to that shell.',
    'A host that cannot apply --shell refuses the create rather than quietly spawning its default shell: macOS and Linux execution hosts spawn the login shell, terminals routed over SSH resolve their shell on the SSH host, a --shell that contradicts the project execution runtime (WSL vs Windows host) is refused, and an Orca host older than --shell is refused by the CLI.'
  ],
  examples: [
    'orca terminal create --json',
    'orca terminal create --worktree active --command "pnpm dev" --json',
    'orca terminal create --worktree path:/projects/myapp --title "RUNNER" --command "npm test"',
    'orca terminal create --worktree path:/projects/myapp --command "pnpm dev" --focus',
    'orca terminal create --worktree path:C:/src/app --shell cmd.exe --json',
    'orca terminal create --worktree active --command "./start-agent.sh" --command-agent claude --view-mode chat --json'
  ]
}
