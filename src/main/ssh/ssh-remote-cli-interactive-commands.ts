// Why: these commands run a foreground/interactive process attached to the
// caller's TTY (or a local tmux pane), which a buffered one-shot relay bridge
// cannot host. Everything else routes through the full host CLI.
export const HOST_INTERACTIVE_COMMANDS: Record<string, string> = {
  serve:
    'orca serve starts a foreground headless Orca server and cannot run through the SSH relay bridge. Run it directly on the machine that should host Orca.',
  'claude-teams':
    'orca claude-teams starts an interactive Claude Code session and cannot run through the SSH relay bridge. Run it in a terminal on the Orca host machine.',
  'agent-teams-tmux':
    'orca agent-teams-tmux is a tmux pane shim for the Orca host machine and cannot run through the SSH relay bridge.',
  'account add':
    'orca account add runs an interactive agent login and cannot run through the buffered SSH relay bridge. Run it directly in a terminal on the Orca host machine.'
}
