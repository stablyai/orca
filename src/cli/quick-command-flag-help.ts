// Why: --scope, --label, --agent, --command and --id are shared with browser and
// linear commands, so quick command wording has to stay scoped to this group.
const QUICK_COMMAND_FLAG_HELP: Record<string, string> = {
  scope: '--scope <scope>        Quick command scope: all, global, repo, or applicable',
  label: '--label <text>         Display label for the quick command',
  agent: '--agent <id>           Agent that receives the saved prompt',
  command: '--command <text>       Shell command the quick command runs',
  id: '--id <quick-command-id> Saved quick command identifier',
  global: '--global               Move the quick command to global scope',
  'no-enter': '--no-enter             Type the command without submitting it'
}

export function formatQuickCommandFlagHelp(command: string, flag: string): string | null {
  if (!command.startsWith('quick-command ')) {
    return null
  }
  return QUICK_COMMAND_FLAG_HELP[flag] ?? null
}
