import { defineMethod } from '../../../core'
import { listLocalTasks } from '../../../../../local-tasks/local-task-store'

// Why: tasks live on the host that runs this runtime, so remote hosts and mobile read them over RPC;
// the renderer never touches the folder directly.
export const LOCAL_TASK_METHODS = [
  defineMethod({
    name: 'localTasks.list',
    permission: 'workspace',
    params: null,
    handler: async () => listLocalTasks()
  })
]
