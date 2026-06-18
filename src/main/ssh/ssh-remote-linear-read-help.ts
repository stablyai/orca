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
  if (matchesRemoteCommand(commandPath, 'linear', 'team', 'list')) {
    return LINEAR_TEAM_LIST_HELP
  }
  if (matchesRemoteCommand(commandPath, 'linear', 'team', 'members')) {
    return LINEAR_TEAM_MEMBERS_HELP
  }
  if (matchesRemoteCommand(commandPath, 'linear', 'team', 'states')) {
    return LINEAR_TEAM_STATES_HELP
  }
  if (matchesRemoteCommand(commandPath, 'linear', 'team', 'labels')) {
    return LINEAR_TEAM_LABELS_HELP
  }
  if (matchesRemoteCommand(commandPath, 'linear', 'project', 'list')) {
    return LINEAR_PROJECT_LIST_HELP
  }
  if (matchesRemoteCommand(commandPath, 'linear', 'list')) {
    return LINEAR_LIST_HELP
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
  team list          List connected Linear teams
  team members       List Linear team members
  team states        List Linear team workflow states
  team labels        List Linear team labels
  project list       List connected Linear projects
  list               List Linear issues
  assignee set       Set a Linear issue assignee
  assignee clear     Clear a Linear issue assignee
  priority set       Set a Linear issue priority
  priority clear     Clear a Linear issue priority
  estimate set       Set a Linear issue estimate
  estimate clear     Clear a Linear issue estimate
  due-date set       Set a Linear issue due date
  due-date clear     Clear a Linear issue due date
  label add          Add labels to a Linear issue
  label remove       Remove labels from a Linear issue
  label set          Replace labels on a Linear issue
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

const LINEAR_TEAM_LIST_HELP = `orca linear team list

Usage: orca linear team list [--workspace <id>|all] [--json]

List connected Linear teams`

const LINEAR_TEAM_MEMBERS_HELP = `orca linear team members

Usage: orca linear team members --team <key|id> [--workspace <id>] [--json]

List Linear team members`

const LINEAR_TEAM_STATES_HELP = `orca linear team states

Usage: orca linear team states --team <key|id> [--workspace <id>] [--json]

List Linear team workflow states`

const LINEAR_TEAM_LABELS_HELP = `orca linear team labels

Usage: orca linear team labels --team <key|id> [--workspace <id>] [--json]

List Linear team labels`

const LINEAR_PROJECT_LIST_HELP = `orca linear project list

Usage: orca linear project list [--query <text>] [--limit <n>] [--workspace <id>|all] [--json]

List connected Linear projects`

const LINEAR_LIST_HELP = `orca linear list

Usage: orca linear list [--filter assigned|created|all|completed|open] [--team <key|id>] [--limit <n>] [--workspace <id>|all] [--json]

List Linear issues`
