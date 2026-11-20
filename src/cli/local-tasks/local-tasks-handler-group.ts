import type { HandlerGroup } from '../dispatch/handler-group-manifest'

export const LOCAL_TASKS_HANDLER_GROUP: HandlerGroup = {
  name: 'local-tasks',
  keys: [
    'local-tasks list',
    'local-tasks get',
    'local-tasks next',
    'local-tasks claim',
    'local-tasks renew',
    'local-tasks release',
    'local-tasks create',
    'local-tasks update'
  ],
  load: async () => (await import('./local-tasks.js')).LOCAL_TASKS_HANDLERS
}
