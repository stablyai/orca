import type { HandlerGroup } from './handler-group-manifest'

export const JIRA_HANDLER_GROUP: HandlerGroup = {
  name: 'jira',
  keys: [
    'jira connection',
    'jira issue',
    'jira list',
    'jira search',
    'jira create',
    'jira project list',
    'jira project types',
    'jira project fields',
    'jira comment list',
    'jira comment add',
    'jira status list',
    'jira status set',
    'jira assignee list',
    'jira assignee set',
    'jira assignee clear',
    'jira priority list',
    'jira priority set',
    'jira priority clear',
    'jira label add',
    'jira label rm',
    'jira label set'
  ],
  load: async () => (await import('./handlers/jira.js')).JIRA_HANDLERS
}
