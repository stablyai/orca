import type { HandlerGroup } from './handler-group-manifest'

export const REFERENCE_HANDLER_GROUP: HandlerGroup = {
  name: 'reference',
  keys: ['reference list', 'reference add', 'reference remove', 'reference find'],
  load: async () => (await import('./handlers/reference.js')).REFERENCE_HANDLERS
}
