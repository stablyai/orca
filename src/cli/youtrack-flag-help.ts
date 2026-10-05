const TARGET_HELP = {
  id: '--id <id>              YouTrack issue ID (PROJ-81) or issue URL',
  current: '--current              Use the YouTrack issue linked to the current Orca worktree'
}

const BODY_HELP = {
  body: '--body <markdown>      Text, in YouTrack Markdown',
  'body-file': '--body-file <path|->   Read the text from a file, or stdin with -'
}

/** Help lines for `orca youtrack`, which share flag names with other groups but not meanings. */
export const YOUTRACK_FLAG_HELP: Record<string, Record<string, string>> = {
  'youtrack issue': {
    ...TARGET_HELP,
    comments: '--comments             Include the issue comments'
  },
  'youtrack list': {
    preset: '--preset <name>        assigned (default), reported, open, or done',
    query: '--query <text>         Any YouTrack query; overrides --preset',
    limit: '--limit <n>            Maximum issues to return (default 50, max 200)'
  },
  'youtrack comment add': { ...TARGET_HELP, ...BODY_HELP },
  'youtrack state set': {
    ...TARGET_HELP,
    to: '--to <state>           Target state or workflow transition, as YouTrack names it'
  },
  'youtrack field set': {
    ...TARGET_HELP,
    name: '--name <field>         Custom field name, as shown in YouTrack',
    value: '--value <value>        Value; repeat for multi-value fields. Periods like "1d 4h"',
    clear: '--clear                Empty the field instead of setting it'
  },
  'youtrack create': {
    ...BODY_HELP,
    project: '--project <key>        Project short name (PROJ), name, or ID',
    summary: '--summary <text>       Issue summary',
    field: '--field <name=value>   Set a field on create; repeat for more fields or values'
  }
}
