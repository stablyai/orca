// Private build only: routes `orca cloud …` to its handlers (loaded on demand).
import type { HandlerGroup } from '../handler-group-manifest'

export const CLOUD_HANDLER_GROUP: HandlerGroup = {
  name: 'cloud',
  keys: [
    'cloud whoami',
    'cloud login',
    'cloud logout',
    'cloud workspace list',
    'cloud workspace show',
    'cloud workspace create',
    'cloud workspace sleep',
    'cloud workspace wake',
    'cloud workspace archive',
    'cloud workspace destroy',
    'cloud message',
    'cloud message status',
    'cloud sessions',
    'cloud projects list'
  ],
  load: async () => (await import('./cloud-handlers.js')).CLOUD_HANDLERS
}
