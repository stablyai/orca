import type { HandlerGroup } from '../dispatch/handler-group-manifest'

export const CLICKUP_HANDLER_GROUP: HandlerGroup = {
  name: 'clickup',
  keys: [
    'clickup status',
    'clickup task',
    'clickup list',
    'clickup search',
    'clickup comment add',
    'clickup status set'
  ],
  load: async () => (await import('./clickup.js')).CLICKUP_HANDLERS
}
