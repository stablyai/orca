import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { resolveWorkerLaunchPreferences } from './worker-launch-preferences'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_ROLE_ROUTING_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'

const harness = createOrchestrationRpcHarness()
let state: ReturnType<typeof harness.setup>
let structuredChat = false
const profiles = {
  research: { agent: 'claude', model: 'sonnet', effort: 'high' },
  implementation: { agent: 'codex', model: 'gpt-5.5', effort: 'high' },
  review: { agent: 'cursor', model: 'gpt-5.3-codex', effort: 'low', fastMode: true },
  invalid: { agent: 'not-a-configured-provider' }
}

beforeEach(() => {
  structuredChat = false
  state = harness.setup()
  const { runtime } = state
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only settings from the store fixture.
  vi.spyOn(runtime, 'requireStore').mockReturnValue({
    getSettings: () => ({
      agentDefaultSurface: structuredChat ? 'chat' : 'terminal',
      orchestrationWorkerRoles: profiles
    })
  } as never)
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'preflightOrchestrationWorkerLaunch').mockResolvedValue(undefined)
  vi.spyOn(runtime, 'resolveOrchestrationAgentLauncherForTarget').mockResolvedValue(undefined)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worker placement reads only the workspace id and repository id.
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
    id: 'repo::folder',
    repoId: 'repo'
  } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: caller workspace resolution reads only worktreeId from this terminal.
  vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
    handle: 'term_coord',
    worktreeId: 'repo::folder',
    status: 'running'
  } as never)
  vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
    handle === 'term_coord' ? harness.coordinatorPaneKey : 'tab_worker:leaf_worker'
  )
  vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
    handle: 'term_worker',
    worktreeId: 'repo::folder',
    title: 'worker'
  })
  vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
    handle: 'term_worker',
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  })
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
  vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
    handle: 'term_worker',
    accepted: true,
    bytesWritten: 1
  })
})

afterEach(() => {
  harness.cleanup()
  vi.restoreAllMocks()
})

function start(params: Record<string, unknown> = {}) {
  return harness.call(
    'orchestration.workerStart',
    {
      from: 'term_coord',
      spec: 'Inspect this folder',
      worktree: 'current',
      role: 'research',
      ...params
    },
    state.ctx
  )
}

function expectNoTaskEffects() {
  expect(state.db.db.prepare('SELECT count(*) AS count FROM tasks').get()).toEqual({ count: 0 })
  expect(state.db.db.prepare('SELECT count(*) AS count FROM dispatch_contexts').get()).toEqual({
    count: 0
  })
  expect(state.runtime.createTerminal).not.toHaveBeenCalled()
}

describe('worker role routing through durable worker-start', () => {
  it.each(['research', 'implementation', 'review'] as const)(
    'launches the %s provider through the original terminal path and records the role',
    async (role) => {
      const result = await start({ role })
      const { dispatchId } = z.object({ dispatchId: z.string() }).parse(result)
      const { agent, ...launchPreferences } = profiles[role]
      expect(result).toMatchObject({
        state: 'ready',
        launch: {
          role,
          requested: { agent, ...launchPreferences },
          effective: { agent, ...launchPreferences }
        }
      })
      expect(state.runtime.createTerminal).toHaveBeenCalledWith(
        'id:repo::folder',
        expect.objectContaining({
          startupAgent: agent,
          launchSource: 'orchestration',
          launchPreferences
        })
      )
      const worker = state.db.getWorkerDispatch(dispatchId)
      expect(worker?.state).toBe('ready')
      expect(JSON.parse(worker?.start_options ?? '{}')).toMatchObject({
        launch: { role, requested: { agent, ...launchPreferences } }
      })
      expect(state.runtime.createTerminal).toHaveBeenCalledWith(
        'id:repo::folder',
        expect.not.objectContaining({ command: expect.anything() })
      )
    }
  )

  it('applies an explicit different provider and model instead of profile defaults', async () => {
    const result = await start({ agent: 'codex', model: 'gpt-5.5', effort: 'medium' })
    expect(result).toMatchObject({
      launch: {
        role: 'research',
        effective: { agent: 'codex', model: 'gpt-5.5', effort: 'medium' }
      }
    })
  })

  it('refuses a host command conflict before task creation', async () => {
    vi.mocked(state.runtime.preflightOrchestrationWorkerLaunch).mockRejectedValue(
      new Error('Agent command override conflicts with the requested launch preferences.')
    )
    await expect(start()).rejects.toThrow('command override conflicts')
    expectNoTaskEffects()
  })

  it.each(['new-child', 'new-top-level'])(
    'validates terminal fallback preferences before creating a structured %s worker',
    async (worktree) => {
      structuredChat = true
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: creation admission reads only the parent workspace and repository ids.
      vi.spyOn(state.runtime, 'showManagedWorktree').mockResolvedValue({
        id: 'repo::parent',
        repoId: 'repo'
      } as never)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: folder-workspace admission reads only the repository kind.
      vi.spyOn(state.runtime, 'showRepo').mockResolvedValue({ id: 'repo', kind: 'git' } as never)
      const create = vi
        .spyOn(state.runtime, 'createManagedWorktree')
        .mockRejectedValue(new Error('Worktree effects must not begin'))
      vi.mocked(state.runtime.preflightOrchestrationWorkerLaunch).mockRejectedValue(
        new Error('Agent command override conflicts with the requested launch preferences.')
      )

      await expect(start({ worktree, name: 'role-worker' })).rejects.toThrow(
        'command override conflicts'
      )
      expectNoTaskEffects()
      expect(create).not.toHaveBeenCalled()
    }
  )

  it.each([
    { role: 'missing' },
    { role: 'invalid' },
    { role: 'research', effort: 'turbo' },
    { role: 'research', fastMode: true },
    { role: 'review', terminal: 'term_existing' },
    { role: undefined }
  ])('refuses invalid selection before task or process side effects: %j', async (params) => {
    await expect(start(params)).rejects.toThrow()
    expectNoTaskEffects()
  })

  it('refuses an old remote host before creating the Task and never starts locally', async () => {
    const remote = remoteCalls([
      ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
      ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
    ])
    await expect(startRemote()).rejects.toMatchObject({ code: 'capability_unsupported' })
    expect(remote.mock.calls.map((call) => call[1])).toEqual(['status.get'])
    expectNoTaskEffects()
  })

  it('runs remote provider preflight before task creation and preserves its refusal', async () => {
    const remote = remoteCalls(remoteCapabilities(), async () => {
      expectNoTaskEffects()
      throw new Error('Selected provider is unavailable on this server')
    })
    await expect(startRemote()).rejects.toThrow('Selected provider is unavailable')
    expect(remote.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'orchestration.workerLaunchPreflight'
    ])
    expectNoTaskEffects()
  })

  it.each([
    undefined,
    {
      role: 'research',
      requested: { agent: 'claude', model: 'sonnet', effort: 'high' },
      effective: { agent: 'claude', model: 'opus', effort: 'high' }
    }
  ])(
    'preserves remote identity for an unverified launch without a duplicate: %j',
    async (launch) => {
      const remote = remoteCalls(remoteCapabilities(), async (method, params) => {
        if (method === 'orchestration.workerLaunchPreflight') {
          return {
            launch: {
              role: 'research',
              requested: { agent: 'claude', model: 'sonnet', effort: 'high' },
              effective: null
            }
          }
        }
        const { dispatchId } = z.object({ dispatchId: z.string() }).parse(params)
        return {
          dispatchId,
          state: 'ready',
          runtimeEpoch: 'remote_1',
          worktreeId: 'remote_folder',
          terminalHandle: 'term_remote',
          ...(launch ? { launch } : {})
        }
      })
      const result = await startRemote()
      const { dispatchId } = z.object({ dispatchId: z.string() }).parse(result)
      expect(result).toMatchObject({
        state: 'outcome_unknown',
        launch: {
          role: 'research',
          requested: { agent: 'claude', model: 'sonnet', effort: 'high' },
          effective: null
        }
      })
      expect(state.db.getFederatedDispatch(dispatchId)).toMatchObject({
        remote_runtime_epoch: 'remote_1',
        remote_worktree_id: 'remote_folder',
        remote_terminal_handle: 'term_remote'
      })
      expect(state.db.getWorkerDispatch(dispatchId)?.state).toBe('start_unknown')
      expect(state.db.db.prepare('SELECT count(*) AS count FROM tasks').get()).toEqual({ count: 1 })
      expect(
        remote.mock.calls.filter((call) => call[1] === 'orchestration.federationAttachStart')
      ).toHaveLength(1)
      expect(state.runtime.createTerminal).not.toHaveBeenCalled()
    }
  )

  it.each([
    { serviceTier: 'priority', ready: true },
    { serviceTier: 'auto', ready: false },
    { serviceTier: undefined, ready: false }
  ])('verifies the remote Codex Fast service tier: %j', async ({ serviceTier, ready }) => {
    const { receipt } = resolveWorkerLaunchPreferences({
      agent: 'codex',
      model: 'gpt-5.5',
      fastMode: true,
      structuredFastModeSupported: true,
      structuredFastServiceTier: 'priority'
    })
    const remote = remoteCalls(remoteCapabilities(), async (method, params) => {
      if (method === 'orchestration.workerLaunchPreflight') {
        return { launch: { ...receipt, effective: null } }
      }
      const { dispatchId } = z.object({ dispatchId: z.string() }).parse(params)
      const { serviceTier: _preflightTier, ...effective } = receipt.requested
      return {
        dispatchId,
        state: 'ready',
        runtimeEpoch: 'remote_1',
        worktreeId: 'remote_folder',
        terminalHandle: 'term_remote',
        launch: {
          ...receipt,
          effective: { ...effective, ...(serviceTier !== undefined ? { serviceTier } : {}) }
        }
      }
    })

    const result = await startRemote({
      role: undefined,
      agent: 'codex',
      model: 'gpt-5.5',
      fastMode: true
    })
    const { dispatchId } = z.object({ dispatchId: z.string() }).parse(result)
    expect(result).toMatchObject({
      state: ready ? 'ready' : 'outcome_unknown',
      launch: { requested: receipt.requested, effective: ready ? receipt.effective : null }
    })
    expect(state.db.getFederatedDispatch(dispatchId)).toMatchObject({
      remote_runtime_epoch: 'remote_1',
      remote_worktree_id: 'remote_folder',
      remote_terminal_handle: 'term_remote'
    })
    const worker = state.db.getWorkerDispatch(dispatchId)
    expect(worker?.state).toBe(ready ? 'ready' : 'start_unknown')
    expect(JSON.parse(worker?.start_options ?? '{}')).toMatchObject({
      launch: { requested: receipt.requested }
    })
    expect(state.db.db.prepare('SELECT count(*) AS count FROM tasks').get()).toEqual({ count: 1 })
    expect(state.db.db.prepare('SELECT count(*) AS count FROM dispatch_contexts').get()).toEqual({
      count: 1
    })
    expect(remote.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'orchestration.workerLaunchPreflight',
      'orchestration.federationAttachStart'
    ])
    expect(state.runtime.createTerminal).not.toHaveBeenCalled()
  })
})

function remoteCapabilities() {
  return [
    ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
    ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
    ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
    ORCHESTRATION_WORKER_ROLE_ROUTING_RUNTIME_CAPABILITY
  ]
}

function remoteCalls(
  capabilities: string[],
  response?: (method: string, params: unknown) => Promise<unknown>
) {
  vi.spyOn(state.runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
    environmentId: 'environment_remote',
    name: 'remote',
    peerFingerprint: 'peer',
    pairingRevision: 3
  })
  return vi
    .spyOn(state.runtime, 'callOrchestrationWorkerServer')
    .mockImplementation(async (_environment, method, params) => {
      if (method === 'status.get') {
        return { capabilities }
      }
      if (response) {
        return response(method, params)
      }
      throw new Error(`Unexpected remote call ${method}`)
    })
}

function startRemote(params: Record<string, unknown> = {}) {
  return harness.call(
    'orchestration.workerStart',
    {
      from: 'term_coord',
      spec: 'Inspect remote folder',
      role: 'research',
      on: 'remote',
      worktree: 'id:remote_folder',
      ...params
    },
    {
      ...state.ctx,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId: 'request_role',
        method: 'orchestration.workerStart',
        payloadHash: 'hash'
      }
    }
  )
}
