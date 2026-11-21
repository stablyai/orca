import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { FederationWorkerLaunchParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-federation-start-params'
import { prepareFederationWorkerLaunchOnHost } from './start/launch/worker-opencode-model-preflight'

export const ORCHESTRATION_WORKER_LAUNCH_PREFLIGHT_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.workerLaunchPreflight',
    access: { kind: 'reads', targets: { terminal: 'worker' } },
    permission: 'workspace',
    params: FederationWorkerLaunchParams,
    handler: async (params, { runtime }) => {
      if (params.worktree === 'current' || params.worktree === 'new-child') {
        throw new OrchestrationError(
          'invalid_argument',
          'Remote launch preflight requires an exact worktree selector or new-top-level.'
        )
      }
      const { launch } = await prepareFederationWorkerLaunchOnHost({
        params,
        createsWorktree: params.worktree === 'new-top-level',
        runtime
      })
      return { launch: { ...launch.receipt, effective: null } }
    }
  })
]
