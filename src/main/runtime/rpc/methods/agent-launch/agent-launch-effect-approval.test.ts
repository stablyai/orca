import { afterEach, expect, it, vi } from 'vitest'
import { structuredAgentSessionSendBody } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { settleOpeningThenRegister } from '../../../../native-chat/agent-session-wire/acquisition/structured-agent-session-opening-withdrawal'
import { agentLaunchSurfaceFactory } from './agent-launch-surfaces'
import { agentLaunchWorkspaceFactory } from './agent-launch-worktree-creation'
import { rpcContext, runtimeStub } from './agent-launch.test-fixture'
import {
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub
} from '../structured-sessions/protocol/structured-agent-session-rpc.test-fixture'

afterEach(clearStructuredHostStub)

/** Ask the create's own recheck, as the runtime does once the workspace exists, right before its agent. */
function askBeforeEffect(args: Record<string, unknown>): void {
  const recheck = args.beforeEffect
  if (typeof recheck === 'function') {
    recheck()
  }
}

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

it('refuses an agent-first worktree whose create outlives its approval', async () => {
  const runtime = runtimeStub()
  let approved = true
  runtime.createManagedWorktree.mockImplementation(async (args) => {
    approved = false
    await Promise.resolve()
    askBeforeEffect(args)
    return { worktree: { id: 'wt-new' }, startupTerminal: { handle: 'term_agent_first' } }
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

it('refuses an agent-first folder workspace whose create outlives its approval', async () => {
  const runtime = runtimeStub()
  let approved = true
  runtime.createFolderWorkspace.mockImplementation(async (input) => {
    approved = false
    await Promise.resolve()
    askBeforeEffect(input)
    return {
      folderWorkspace: { id: 'fw-new' },
      startupTerminal: { spawned: true, handle: 'term_1' }
    }
  })
  const context = rpcContext(runtime, {
    beforeEffect: () => {
      if (!approved) {
        throw new Error('plugin_approval_revoked')
      }
    }
  })

  const createFolderWorkspace = agentLaunchWorkspaceFactory(context, 'claude').createFolderWorkspace
  if (!createFolderWorkspace) {
    throw new Error('agent_launch_workspace_factory_required')
  }

  await expect(
    createFolderWorkspace({
      create: { projectGroupId: 'group-1', name: 'review' },
      startupAgent: 'claude'
    })
  ).rejects.toThrow('plugin_approval_revoked')
})

it('keeps the opening message from the agent once its caller is refused before delivery', async () => {
  installStructuredHostStub()
  let approved = true
  const withdrawn: string[] = []
  // Sent and published, the chat registers next; the real settlement asks the caller right there.
  hostCalls.create = vi.fn(async (_caller, _params, options) => {
    approved = false
    await settleOpeningThenRegister(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the settlement reads one pending submission and records its withdrawal, nothing else.
      {
        reads: { submission: async () => ({ dispatchState: 'pending' }) },
        resolveDispatch: async ({ clientMessageId }: { clientMessageId: string }) => {
          withdrawn.push(clientMessageId)
        }
      } as never,
      options,
      1,
      () => {},
      () => {}
    )
    return { ok: true, value: { sessionId: 'session-1', fence: 1 } }
  })
  const context = rpcContext(runtimeStub(), {
    beforeEffect: () => {
      if (!approved) {
        throw new Error('plugin_approval_revoked')
      }
    }
  })

  await agentLaunchSurfaceFactory(context).createStructuredSession({
    worktreeId: 'wt-7',
    agent: 'claude',
    firstMessage: {
      clientMessageId: 'opening-1',
      body: structuredAgentSessionSendBody('Run the tests.', [])
    }
  })

  expect(withdrawn).toEqual(['opening-1'])
})
