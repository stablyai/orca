import type { HandlerGroup } from './handler-group-manifest'

export const CLICKUP_HANDLER_GROUP: HandlerGroup = {
  name: 'clickup',
  keys: [
    'clickup workspace list',
    'clickup destination list',
    'clickup list',
    'clickup search',
    'clickup task',
    'clickup status set',
    'clickup priority set',
    'clickup priority clear',
    'clickup due-date set',
    'clickup due-date clear',
    'clickup comment add',
    'clickup create'
  ],
  load: async () => (await import('./handlers/clickup.js')).CLICKUP_HANDLERS
}
