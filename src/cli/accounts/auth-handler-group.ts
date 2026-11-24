import type { HandlerGroup } from '../dispatch/handler-group-manifest'

export const AUTH_HANDLER_GROUP: HandlerGroup = {
  name: 'auth',
  keys: ['auth login', 'auth status', 'auth logout'],
  load: async () => (await import('./auth.js')).AUTH_HANDLERS
}
