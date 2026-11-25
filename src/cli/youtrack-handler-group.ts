import type { HandlerGroup } from './dispatch/handler-group-manifest'

export const YOUTRACK_HANDLER_GROUP: HandlerGroup = {
  name: 'youtrack',
  keys: [
    'youtrack issue',
    'youtrack list',
    'youtrack comment add',
    'youtrack state set',
    'youtrack field set',
    'youtrack create'
  ],
  load: async () => (await import('./workspaces/youtrack.js')).YOUTRACK_HANDLERS
}
