import { defineMethod } from '../../../core'
import { listLocalTasks } from '../../../../../local-tasks/local-task-store'
import {
  claimLocalTask,
  createLocalTask,
  releaseLocalTask,
  updateLocalTask
} from '../../../../../local-tasks/local-task-writes'
import {
  ClaimLocalTask,
  CreateLocalTask,
  ReleaseLocalTask,
  UpdateLocalTask
} from '../../../../../../shared/rpc-contract/local-tasks/local-tasks-params'

// Why: tasks live on the host that runs this runtime, so remote hosts and mobile read them over RPC;
// the renderer never touches the folder directly.
export const LOCAL_TASK_METHODS = [
  defineMethod({
    name: 'localTasks.list',
    permission: 'workspace',
    params: null,
    handler: async () => listLocalTasks()
  }),
  defineMethod({
    name: 'localTasks.create',
    permission: 'workspace',
    params: CreateLocalTask,
    handler: async (params) => createLocalTask(params)
  }),
  defineMethod({
    name: 'localTasks.update',
    permission: 'workspace',
    params: UpdateLocalTask,
    handler: async (params) => updateLocalTask(params.id, params.patch)
  }),
  defineMethod({
    name: 'localTasks.claim',
    permission: 'workspace',
    params: ClaimLocalTask,
    handler: async (params) => claimLocalTask(params.id, params.claimer)
  }),
  defineMethod({
    name: 'localTasks.release',
    permission: 'workspace',
    params: ReleaseLocalTask,
    handler: async (params) => releaseLocalTask(params.id, params.claimer)
  })
]
