import type { HandlerGroup } from '../dispatch/handler-group-manifest'

export const PLANE_HANDLER_GROUP: HandlerGroup = {
  name: 'plane',
  keys: [
    'plane status',
    'plane connect',
    'plane disconnect',
    'plane workspace list',
    'plane workspace select',
    'plane project list',
    'plane state list',
    'plane list',
    'plane issue',
    'plane create',
    'plane status set',
    'plane priority set',
    'plane priority clear',
    'plane comment add'
  ],
  load: async () => (await import('./plane.js')).PLANE_HANDLERS
}
