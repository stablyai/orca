import type { HandlerGroup } from './handler-group-manifest'

export const PROJECT_GROUP_HANDLER_GROUP: HandlerGroup = {
  name: 'project-group',
  keys: [
    'project group list',
    'project group create',
    'project group rename',
    'project group rm',
    'project group add',
    'project group ungroup'
  ],
  load: async () => (await import('./handlers/project-group.js')).PROJECT_GROUP_HANDLERS
}
