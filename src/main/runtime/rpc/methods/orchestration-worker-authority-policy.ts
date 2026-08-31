import { z } from 'zod'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import {
  NO_GITHUB_AUTHORITY_POLICY,
  isNoGithubAuthorityPolicySupported,
  issueWorkerAuthorityPolicyCapability
} from '../../../../shared/worker-authority-policy'
import { verifyWorkerAuthorityContainerRuntime } from '../../../providers/worker-authority-isolation'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

const WorkerPolicyCheckParams = z.object({
  policy: requiredString('Missing --policy'),
  agent: requiredString('Missing --agent'),
  worktree: requiredString('Missing --worktree'),
  setup: z.enum(['run', 'skip', 'inherit']),
  on: OptionalString
})

export const ORCHESTRATION_WORKER_AUTHORITY_POLICY_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerPolicyCheck',
    params: WorkerPolicyCheckParams,
    handler: async (params, { runtime }) => {
      if (
        params.policy !== NO_GITHUB_AUTHORITY_POLICY ||
        !isTuiAgent(params.agent) ||
        params.on ||
        params.setup !== 'skip' ||
        params.worktree === 'current' ||
        params.worktree.startsWith('new-')
      ) {
        throw new OrchestrationError(
          'worker_authority_policy_unsupported',
          'The selected policy, agent, or worker host cannot enforce NO_GITHUB_AUTHORITY.'
        )
      }
      if (
        !isNoGithubAuthorityPolicySupported({
          agent: params.agent,
          processOwnerSupportsIsolation: runtime.supportsWorkerAuthorityIsolation(params.agent)
        }) ||
        !(await verifyWorkerAuthorityContainerRuntime())
      ) {
        throw new OrchestrationError(
          'worker_authority_policy_unsupported',
          'This Orca execution host cannot enforce NO_GITHUB_AUTHORITY for the selected agent.'
        )
      }
      const worktree = await runtime.showManagedTerminalWorkspace(params.worktree)
      if (worktree.id.startsWith('folder:')) {
        throw new OrchestrationError(
          'worker_authority_policy_unsupported',
          'NO_GITHUB_AUTHORITY currently requires a Git worktree workspace.'
        )
      }
      return issueWorkerAuthorityPolicyCapability({
        runtimeId: runtime.getRuntimeId(),
        agentId: params.agent,
        worktreeId: worktree.id,
        setupPolicy: params.setup
      })
    }
  })
]
