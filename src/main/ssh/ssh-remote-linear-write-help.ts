type ParsedRemoteCli = {
  commandPath: string[]
  flags: Map<string, string | boolean>
}

function matchesRemoteCommand(commandPath: string[], ...command: string[]): boolean {
  return (
    commandPath.length === command.length &&
    command.every((part, index) => commandPath[index] === part)
  )
}

export function getRemoteLinearWriteHelp(parsed: ParsedRemoteCli): string | null {
  const path = parsed.commandPath
  if (matchesRemoteCommand(path, 'linear', 'status', 'set')) {
    return LINEAR_STATUS_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'assignee', 'set')) {
    return LINEAR_ASSIGNEE_SET_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'assignee', 'clear')) {
    return LINEAR_ASSIGNEE_CLEAR_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'priority', 'set')) {
    return LINEAR_PRIORITY_SET_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'priority', 'clear')) {
    return LINEAR_PRIORITY_CLEAR_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'estimate', 'set')) {
    return LINEAR_ESTIMATE_SET_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'estimate', 'clear')) {
    return LINEAR_ESTIMATE_CLEAR_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'due-date', 'set')) {
    return LINEAR_DUE_DATE_SET_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'due-date', 'clear')) {
    return LINEAR_DUE_DATE_CLEAR_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'label', 'add')) {
    return LINEAR_LABEL_ADD_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'label', 'remove')) {
    return LINEAR_LABEL_REMOVE_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'label', 'set')) {
    return LINEAR_LABEL_SET_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'comment', 'add')) {
    return LINEAR_COMMENT_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'attach')) {
    return LINEAR_ATTACH_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'create')) {
    return LINEAR_CREATE_HELP
  }
  return null
}

const LINEAR_STATUS_HELP = `orca linear status set\n\nUsage: orca linear status set [<id>] [--current] --to <state> [--workspace <id>] [--json]\n\nSet a Linear issue status`
const LINEAR_ASSIGNEE_SET_HELP = `orca linear assignee set\n\nUsage: orca linear assignee set [<id>] [--current] (--me | --to-id <userId>) [--workspace <id>] [--json]\n\nSet a Linear issue assignee`
const LINEAR_ASSIGNEE_CLEAR_HELP = `orca linear assignee clear\n\nUsage: orca linear assignee clear [<id>] [--current] [--workspace <id>] [--json]\n\nClear a Linear issue assignee`
const LINEAR_PRIORITY_SET_HELP = `orca linear priority set\n\nUsage: orca linear priority set [<id>] [--current] --to none|low|medium|high|urgent [--workspace <id>] [--json]\n\nSet a Linear issue priority`
const LINEAR_PRIORITY_CLEAR_HELP = `orca linear priority clear\n\nUsage: orca linear priority clear [<id>] [--current] [--workspace <id>] [--json]\n\nClear a Linear issue priority`
const LINEAR_ESTIMATE_SET_HELP = `orca linear estimate set\n\nUsage: orca linear estimate set [<id>] [--current] --to <number> [--workspace <id>] [--json]\n\nSet a Linear issue estimate`
const LINEAR_ESTIMATE_CLEAR_HELP = `orca linear estimate clear\n\nUsage: orca linear estimate clear [<id>] [--current] [--workspace <id>] [--json]\n\nClear a Linear issue estimate`
const LINEAR_DUE_DATE_SET_HELP = `orca linear due-date set\n\nUsage: orca linear due-date set [<id>] [--current] --to <yyyy-mm-dd> [--workspace <id>] [--json]\n\nSet a Linear issue due date`
const LINEAR_DUE_DATE_CLEAR_HELP = `orca linear due-date clear\n\nUsage: orca linear due-date clear [<id>] [--current] [--workspace <id>] [--json]\n\nClear a Linear issue due date`
const LINEAR_LABEL_ADD_HELP = `orca linear label add\n\nUsage: orca linear label add [<id>] [--current] --label <labelId-or-exact-name>... [--workspace <id>] [--json]\n\nAdd labels to a Linear issue`
const LINEAR_LABEL_REMOVE_HELP = `orca linear label remove\n\nUsage: orca linear label remove [<id>] [--current] --label <labelId-or-exact-name>... [--workspace <id>] [--json]\n\nRemove labels from a Linear issue`
const LINEAR_LABEL_SET_HELP = `orca linear label set\n\nUsage: orca linear label set [<id>] [--current] --label <labelId-or-exact-name>... [--workspace <id>] [--json]\n\nReplace labels on a Linear issue`
const LINEAR_COMMENT_HELP = `orca linear comment add\n\nUsage: orca linear comment add [<id>] [--current] (--body <text> | --body-file -) [--reply-to <commentId>] [--write-id <uuid>] [--workspace <id>] [--json]\n\nAdd a comment to a Linear issue`
const LINEAR_ATTACH_HELP = `orca linear attach\n\nUsage: orca linear attach [<id>] [--current] --url <url> [--title <title>] [--write-id <uuid>] [--workspace <id>] [--json]\n\nAttach a link to a Linear issue`
const LINEAR_CREATE_HELP = `orca linear create\n\nUsage: orca linear create --title <title> [--body <text> | --body-file -] [--team <key|id>] [--project <projectId-or-exact-name>] [--state <stateId|exact-name>] [--assignee me|<userId>] [--priority none|low|medium|high|urgent] [--estimate <number>] [--due-date <yyyy-mm-dd>] [--label <labelId-or-exact-name>]... [--parent <id> | --parent-current] [--write-id <uuid>] [--workspace <id>] [--json]\n\nCreate a Linear issue`
