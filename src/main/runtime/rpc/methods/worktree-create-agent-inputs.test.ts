import { getDefaultSettings } from '../../../../shared/constants'
import { OrcaRuntimeWithActivateManagedWorktree } from '../../workspaces/startup/workspace-activation'
import { resolveManagedWorktreeCreateStartup } from '../../workspaces/startup/managed-worktree-create-startup'
import type { RuntimeManagedWorktreeCreateArgs } from '../../workspaces/creation/runtime-managed-worktree-create-types'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './workspaces/worktree'
import '../unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { WorktreeCreate } from '../../../../shared/rpc-contract/worktree-create-params'
import { buildManagedWorktreeCreateArgs } from './workspaces/worktree-create-args'

it('keeps picks and authored empty Arguments across the worktree.create boundary', () => {
  const args = buildManagedWorktreeCreateArgs(
    WorktreeCreate.parse({
      repo: 'repo',
      startupAgent: 'claude',
      startupAgentArgs: '',
      startupSessionOptions: { model: 'opus', effort: 'high', permissionMode: 'full-access' },
      startupLaunchPreferences: { model: 'opus', effort: 'high', mode: 'full-access' }
    }),
    {}
  )
  expect(args).toMatchObject({
    startupAgent: 'claude',
    startupAgentArgs: '',
    startupSessionOptions: { model: 'opus', effort: 'high', permissionMode: 'full-access' },
    startupLaunchPreferences: { model: 'opus', effort: 'high', mode: 'full-access' }
  })
})

it('passes draft inputs to the host builder without refusing a disabled requested agent', async () => {
  const args = buildManagedWorktreeCreateArgs(
    WorktreeCreate.parse({
      repo: 'repo',
      createdWithAgent: 'claude',
      startupDraft: 'ship it',
      startupAgentArgs: null,
      startupSessionOptions: { model: 'opus' }
    }),
    {}
  )
  const result = await resolveManagedWorktreeCreateStartup(args, ['claude'], {
    agent: () => {
      throw new Error('ordinary-agent path reached')
    },
    draft: async (draft, agent, _source, inputs) => {
      expect({
        draft,
        agent,
        args: inputs?.startupAgentArgs,
        options: inputs?.startupSessionOptions
      }).toEqual({ draft: 'ship it', agent: 'claude', args: null, options: { model: 'opus' } })
      return {
        agent: 'codex',
        startup: {
          command: 'codex',
          telemetry: { agent_kind: 'codex', launch_source: 'unknown', request_kind: 'new' }
        },
        draftPaste: { agent: 'codex', content: draft },
        launchRuntime: new Error('fixture')
      }
    }
  })
  expect(result.effectiveCreatedWithAgent).toBe('codex')
  expect(result.effectiveDraftPaste).toEqual({ agent: 'codex', content: 'ship it' })
})

const repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1
}
function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req', authToken: 'tok', method, params }
}
const passthroughDedupe = <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
  run()

abstract class DraftStartupFixture extends OrcaRuntimeWithActivateManagedWorktree {
  public composeDraft(...args: Parameters<typeof this.buildStartupForDraft>) {
    return super.buildStartupForDraft(...args)
  }
}

it('drops original picks after disabled-agent substitution through worktree.create and its executor', async () => {
  const settings = {
    ...getDefaultSettings('/tmp'),
    disabledTuiAgents: ['claude'],
    agentDefaultArgs: { codex: '--model host-model' }
  }
  const compose = vi.fn(async (args: RuntimeManagedWorktreeCreateArgs) =>
    resolveManagedWorktreeCreateStartup(args, settings.disabledTuiAgents, {
      agent: () => {
        throw new Error('draft must keep its draft path')
      },
      draft: (...input) =>
        DraftStartupFixture.prototype.composeDraft.call(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the three dependencies used by the real startup builder.
          {
            store: { getSettings: () => settings },
            toAgentSessionOptions: () => undefined,
            resolveStartupAgentLaunchRuntime: () => ({
              platform: 'linux',
              shell: 'posix',
              launchRuntime: { platform: 'linux', pty: {} }
            })
          } as never,
          { ...repo, executionHostId: 'local' },
          ...input
        )
    })
  )
  const runtimeFixture = {
    getRuntimeId: () => 'test-runtime',
    dedupeWorktreeCreate: passthroughDedupe,
    showRepo: async () => ({ ...repo, executionHostId: 'local' }),
    requireStore: () => ({ getSettings: () => settings }),
    resolveStartupDraftAgent: async () => 'codex',
    createManagedWorktree: async (args: RuntimeManagedWorktreeCreateArgs) => {
      await compose(args)
      return { worktree: { id: 'wt' } }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this RPC fixture supplies the runtime methods invoked by worktree.create; unrelated service internals are intentionally absent.
  const runtime = runtimeFixture as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
  const response = await dispatcher.dispatch(
    makeRequest('worktree.create', {
      repo: 'repo-1',
      name: 'feature',
      createdWithAgent: 'claude',
      startupDraft: 'ship it',
      startupSessionOptions: { model: 'opus', effort: 'high' },
      startupAgentArgs: '--add-dir /claude-only'
    })
  )
  expect(response.ok, JSON.stringify(response)).toBe(true)
  expect(compose.mock.calls[0]?.[0]).toMatchObject({
    createdWithAgent: 'claude',
    startupDraftAgent: 'codex'
  })
  const built = await compose.mock.results[0]?.value
  expect(built?.effectiveStartup?.command).toContain('host-model')
  expect(built?.effectiveStartup?.command).not.toContain('opus')
  expect(built?.effectiveStartup?.command).not.toContain('/claude-only')
  expect(built?.effectiveCreatedWithAgent).toBe('codex')
  expect(built?.effectiveDraftPaste).toEqual({ agent: 'codex', content: 'ship it' })
})
