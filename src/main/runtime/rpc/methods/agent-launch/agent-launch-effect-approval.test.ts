import { expect, it } from 'vitest'
import { agentLaunchSurfaceFactory } from './agent-launch-surfaces'
import { agentLaunchWorkspaceFactory } from './agent-launch-worktree-creation'
import { rpcContext, runtimeStub } from './agent-launch.test-fixture'

it('refuses terminal creation after its caller loses approval', async () => {
  const runtime = runtimeStub()
  const context = rpcContext(runtime, {
    beforeEffect: () => {
      throw new Error('plugin_approval_revoked')
    }
  })

  await expect(
    agentLaunchSurfaceFactory(context).createTerminalAgent({
      worktreeId: 'wt-7',
      agent: 'claude'
    })
  ).rejects.toThrow('plugin_approval_revoked')
})

it('refuses terminal dispatch when preparation outlives its approval', async () => {
  const runtime = runtimeStub()
  let approved = true
  const created = { handle: 'term_1' }
  runtime.createTerminal.mockImplementation(async (_selector, options) => {
    await Promise.resolve()
    approved = false
    const onDispatch = options?.onPtySpawnDispatched
    if (typeof onDispatch === 'function') {
      onDispatch()
    }
    return created
  })
  const context = rpcContext(runtime, {
    beforeEffect: () => {
      if (!approved) {
        throw new Error('plugin_approval_revoked')
      }
    }
  })

  await expect(
    agentLaunchSurfaceFactory(context).createTerminalAgent({
      worktreeId: 'wt-7',
      agent: 'claude'
    })
  ).rejects.toThrow('plugin_approval_revoked')
})

it('refuses an agent-first worktree when repository resolution outlives its approval', async () => {
  const runtime = runtimeStub()
  let approved = true
  runtime.showRepo.mockImplementation(async () => {
    approved = false
    return { id: 'repo-1' }
  })
  const context = rpcContext(runtime, {
    beforeEffect: () => {
      if (!approved) {
        throw new Error('plugin_approval_revoked')
      }
    }
  })

  await expect(
    agentLaunchWorkspaceFactory(context, 'claude').createWorktree({
      create: { repo: 'repo-1', name: 'review' },
      startupAgent: 'claude'
    })
  ).rejects.toThrow('plugin_approval_revoked')
})
