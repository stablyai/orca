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
  if (matchesRemoteCommand(path, 'linear', 'save-issue')) {
    return LINEAR_SAVE_ISSUE_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'relation', 'add')) {
    return LINEAR_RELATION_ADD_HELP
  }
  if (
    matchesRemoteCommand(path, 'linear', 'relation', 'remove') ||
    matchesRemoteCommand(path, 'linear', 'relation', 'rm')
  ) {
    return LINEAR_RELATION_REMOVE_HELP
  }
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

const LINEAR_SAVE_ISSUE_HELP = `mcode linear save-issue\n\nUsage: mcode linear save-issue [<id>] [--current] [--team <key|id>] [--title <title>] [--description <text> | --body-file -] [--state <state>] [--assignee me|<user>|null] [--priority none|low|medium|high|urgent] [--estimate <number>|null] [--due-date <yyyy-mm-dd>|null] [--label <label>...] [--project <project>|null] [--parent-id <issue>|null] [--write-id <uuid>] [--workspace <id>] [--json]\n\nCreate or update a Linear issue`
const LINEAR_RELATION_ADD_HELP = `mcode linear relation add\n\nUsage: mcode linear relation add [<id>] [--current] --related <issue> --type blocks|blocked-by|related|duplicate-of [--workspace <id>] [--json]\n\nAdd a Linear issue relation`
const LINEAR_RELATION_REMOVE_HELP = `mcode linear relation remove\n\nUsage: mcode linear relation remove [<id>] [--current] --related <issue> --type blocks|blocked-by|related|duplicate-of [--workspace <id>] [--json]\n\nRemove a Linear issue relation`

const LINEAR_STATUS_HELP = `mcode linear status set\n\nUsage: mcode linear status set [<id>] [--current] --to <state> [--workspace <id>] [--json]\n\nSet a Linear issue status`
const LINEAR_ASSIGNEE_SET_HELP = `mcode linear assignee set\n\nUsage: mcode linear assignee set [<id>] [--current] (--me | --to-id <userId>) [--workspace <id>] [--json]\n\nSet a Linear issue assignee`
const LINEAR_ASSIGNEE_CLEAR_HELP = `mcode linear assignee clear\n\nUsage: mcode linear assignee clear [<id>] [--current] [--workspace <id>] [--json]\n\nClear a Linear issue assignee`
const LINEAR_PRIORITY_SET_HELP = `mcode linear priority set\n\nUsage: mcode linear priority set [<id>] [--current] --to none|low|medium|high|urgent [--workspace <id>] [--json]\n\nSet a Linear issue priority`
const LINEAR_PRIORITY_CLEAR_HELP = `mcode linear priority clear\n\nUsage: mcode linear priority clear [<id>] [--current] [--workspace <id>] [--json]\n\nClear a Linear issue priority`
const LINEAR_ESTIMATE_SET_HELP = `mcode linear estimate set\n\nUsage: mcode linear estimate set [<id>] [--current] --to <number> [--workspace <id>] [--json]\n\nSet a Linear issue estimate`
const LINEAR_ESTIMATE_CLEAR_HELP = `mcode linear estimate clear\n\nUsage: mcode linear estimate clear [<id>] [--current] [--workspace <id>] [--json]\n\nClear a Linear issue estimate`
const LINEAR_DUE_DATE_SET_HELP = `mcode linear due-date set\n\nUsage: mcode linear due-date set [<id>] [--current] --to <yyyy-mm-dd> [--workspace <id>] [--json]\n\nSet a Linear issue due date`
const LINEAR_DUE_DATE_CLEAR_HELP = `mcode linear due-date clear\n\nUsage: mcode linear due-date clear [<id>] [--current] [--workspace <id>] [--json]\n\nClear a Linear issue due date`
const LINEAR_LABEL_ADD_HELP = `mcode linear label add\n\nUsage: mcode linear label add [<id>] [--current] --label <labelId-or-exact-name>... [--workspace <id>] [--json]\n\nAdd labels to a Linear issue`
const LINEAR_LABEL_REMOVE_HELP = `mcode linear label remove\n\nUsage: mcode linear label remove [<id>] [--current] --label <labelId-or-exact-name>... [--workspace <id>] [--json]\n\nRemove labels from a Linear issue`
const LINEAR_LABEL_SET_HELP = `mcode linear label set\n\nUsage: mcode linear label set [<id>] [--current] --label <labelId-or-exact-name>... [--workspace <id>] [--json]\n\nReplace labels on a Linear issue`
const LINEAR_COMMENT_HELP = `mcode linear comment add\n\nUsage: mcode linear comment add [<id>] [--current] (--body <text> | --body-file -) [--reply-to <commentId>] [--write-id <uuid>] [--workspace <id>] [--json]\n\nAdd a comment to a Linear issue`
const LINEAR_ATTACH_HELP = `mcode linear attach\n\nUsage: mcode linear attach [<id>] [--current] --url <url> [--title <title>] [--write-id <uuid>] [--workspace <id>] [--json]\n\nAttach a link to a Linear issue`
const LINEAR_CREATE_HELP = `mcode linear create\n\nUsage: mcode linear create --title <title> [--body <text> | --body-file -] [--team <key|id>] [--project <projectId-or-exact-name>] [--state <stateId|exact-name>] [--assignee me|<userId>] [--priority none|low|medium|high|urgent] [--estimate <number>] [--due-date <yyyy-mm-dd>] [--label <labelId-or-exact-name>]... [--parent <id> | --parent-current] [--write-id <uuid>] [--workspace <id>] [--json]\n\nCreate a Linear issue`
