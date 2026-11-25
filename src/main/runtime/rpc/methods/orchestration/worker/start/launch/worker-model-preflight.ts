import {
  prepareFederationConfiguredWorkerStart,
  resolveWorkerConfiguredAgentParams
} from './worker-configured-agent-preflight'
import {
  prepareLocalWorkerStart,
  type prepareFederationAttachmentWorkerStart
} from './worker-start-validation'
import { assertDoubaoWorkerModel } from './doubao-worker-model-preflight'
import { probeWorkerOpenCodeModelLaunchSupport } from './worker-opencode-model-preflight'

export async function prepareLocalWorkerLaunchOnHost(
  args: Omit<Parameters<typeof prepareLocalWorkerStart>[0], 'openCodeModelLaunchSupported'>,
  target: { repo: string } | { worktree: string }
) {
  const openCodeModelLaunchSupported =
    'worktree' in target &&
    args.params.agent === 'opencode' &&
    (await probeWorkerOpenCodeModelLaunchSupport(args.runtime, args.params, target))
  const prepared = prepareLocalWorkerStart({ ...args, openCodeModelLaunchSupported })
  await assertDoubaoWorkerModel(args.runtime, { ...args.params, agent: prepared.agent }, target)
  return prepared
}

export async function prepareFederationWorkerLaunchOnHost(
  args: Omit<
    Parameters<typeof prepareFederationAttachmentWorkerStart>[0],
    'openCodeModelLaunchSupported'
  >
) {
  const params = await resolveWorkerConfiguredAgentParams(args.runtime, args.params, async () =>
    args.createsWorktree ? { repo: args.params.repo } : { worktree: args.params.worktree }
  )
  const openCodeModelLaunchSupported =
    !args.createsWorktree &&
    (await probeWorkerOpenCodeModelLaunchSupport(args.runtime, params, {
      worktree: params.worktree
    }))
  const prepared = await prepareFederationConfiguredWorkerStart({
    ...args,
    params,
    openCodeModelLaunchSupported
  })
  await assertDoubaoWorkerModel(
    args.runtime,
    { ...params, agent: prepared.agent },
    args.createsWorktree && params.repo ? { repo: params.repo } : { worktree: params.worktree }
  )
  return prepared
}
