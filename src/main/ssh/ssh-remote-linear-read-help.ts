export function getRemoteLinearReadHelp(commandPath: string[]): string | null {
  if (commandPath.length === 1 && commandPath[0] === 'linear') {
    return LINEAR_HELP
  }
  if (matchesRemoteCommand(commandPath, 'linear', 'issue')) {
    return LINEAR_ISSUE_HELP
  }
  if (matchesRemoteCommand(commandPath, 'linear', 'search')) {
    return LINEAR_SEARCH_HELP
  }
  return null
}

function matchesRemoteCommand(commandPath: string[], ...command: string[]): boolean {
  return (
    commandPath.length === command.length &&
    command.every((part, index) => commandPath[index] === part)
  )
}

const LINEAR_HELP = `orca linear

Usage: orca linear <command> [options]

Commands:
  issue              Read Linear issue context for agents
  search             Search connected Linear workspaces
  status set         Set a Linear issue status
  comment add        Add a comment to a Linear issue
  attach             Attach a link to a Linear issue
  create             Create a Linear issue

Run \`orca linear <command> --help\` for command-specific usage.`

const LINEAR_ISSUE_HELP = `orca linear issue

Usage: orca linear issue [<id>] [--current] [--comments] [--children] [--depth <n>] [--attachments] [--relations] [--full] [--workspace <id>] [--json]

Read Linear issue context for agents

Options:
  --help                 Show this help message
  --json                 Emit machine-readable JSON
  --pairing-code
  --environment
  --current              Use the current Orca worktree linked Linear issue
  --comments             Include threaded Linear comments
  --children             Include recursive child issues
  --depth <n>            Child issue depth for --children/--full
  --attachments          Include attachment metadata and URLs
  --relations            Include blocking, related, and duplicate links
  --full                 Include all supported V1 issue context within caps
  --workspace <id>      Connected Linear workspace id
  --id <id>             Linear issue key, id, or URL

Examples:
  $ orca linear issue ENG-123
  $ orca linear issue --current --comments
  $ orca linear issue https://linear.app/acme/issue/ENG-123 --full --json`

const LINEAR_SEARCH_HELP = `orca linear search

Usage: orca linear search <query> [--limit <n>] [--workspace <id>|all] [--json]

Search connected Linear workspaces

Options:
  --help                 Show this help message
  --json                 Emit machine-readable JSON
  --pairing-code
  --environment
  --limit <n>            Maximum number of rows to return
  --workspace <id|all>  Connected Linear workspace id, or all
  --query <text>        Text to search across Linear issues

Examples:
  $ orca linear search "auth bug"
  $ orca linear search ENG --workspace all --json`
