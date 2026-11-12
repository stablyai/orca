import { describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_RUNTIME_CAPABILITIES,
  ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { getFollowUpDispatch } from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { AGENT_MODEL_DISCOVERY_METHODS } from '../../terminal/agent-model-discovery'
import { methodNamed, rpcContext, runtimeStub } from '../../agent-launch/agent-launch.test-fixture'
import { receipt, useHelperFollowUpCli } from './helper-follow-up-cli.test-support'

const listing = {
  success: true as const,
  catalogOrigin: 'probe' as const,
  capability: {
    id: 'antigravity' as const,
    label: 'Antigravity',
    modelSource: 'dynamic' as const,
    models: [],
    defaultModelId: ''
  },
  defaultModelId: '',
  models: [
    { id: 'gemini-3.8-flash-low', label: 'Flash (Low)' },
    { id: 'gemini-3.8-flash-high', label: 'Flash (High)' }
  ]
}
const pair = ['--agent', 'antigravity', '--model', 'gemini-3.8-flash-high', '--effort', 'low']

describe('Antigravity effort through CLI argv, RPC and worker admission', () => {
  const { h, cli, success, report, follow, effects } = useHelperFollowUpCli()

  it('refuses an explicit conflict before effects, but passes inability and preserves a saved follow-up', async () => {
    const discover = vi.spyOn(h.runtime, 'discoverTerminalModels').mockResolvedValue(listing)
    const before = effects()
    const refused = await cli('worker-start', '--from', 'term_coord', '--spec', 'check', ...pair)
    expect(refused.error).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('--model gemini-3.8-flash --effort low')
    })
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
    expect(effects()).toEqual(before)
    discover.mockRejectedValueOnce(new Error('method_not_found'))
    const started = receipt.parse(
      await success('worker-start', '--from', 'term_coord', '--spec', 'check', ...pair)
    )
    expect(h.runtime.createTerminal).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        launchPreferences: { model: 'gemini-3.8-flash-high', effort: 'low' }
      })
    )
    await report('term_worker', started, 'term_coord')
    discover.mockClear()
    expect((await follow('term_coord', started.dispatchId)).error).toBeUndefined()
    expect(discover).not.toHaveBeenCalled()
    expect(getFollowUpDispatch(h.db, started.dispatchId)).toBeDefined()
    expect(h.runtime.createTerminal).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        launchPreferences: { model: 'gemini-3.8-flash-high', effort: 'low' }
      })
    )
  })

  it.each([
    ['id:remote-worktree', [], true],
    ['id:remote-worktree', [], false]
  ] as const)(
    'checks %s on its destination before dispatch creation',
    async (worktree, repo, modern) => {
      vi.spyOn(h.runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
        environmentId: 'destination',
        name: 'Destination',
        peerFingerprint: 'peer',
        pairingRevision: 7
      })
      const dest = destination()
      const call = vi
        .spyOn(h.runtime, 'callOrchestrationWorkerServer')
        .mockImplementation(async (_host, method, params) => {
          if (method === 'status.get') {
            return {
              capabilities: modern
                ? ORCHESTRATION_RUNTIME_CAPABILITIES
                : ORCHESTRATION_RUNTIME_CAPABILITIES.filter(
                    (c) => c !== ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY
                  )
            }
          }
          if (method === 'agent.discoverTerminalModels') {
            return modern ? dest.read(params) : listing
          }
          throw new Error(`Unexpected remote method: ${method}`)
        })
      const before = effects()
      const result = await cli(
        'worker-start',
        '--from',
        'term_coord',
        '--spec',
        'remote check',
        '--on',
        'destination',
        '--worktree',
        worktree,
        ...repo,
        ...pair
      )
      expect(
        result.error,
        JSON.stringify({ result, calls: call.mock.calls, exitCode: process.exitCode })
      ).toMatchObject({
        code: 'invalid_argument',
        message: expect.stringContaining('--model gemini-3.8-flash --effort low')
      })
      expect(call).toHaveBeenLastCalledWith(
        'destination',
        'agent.discoverTerminalModels',
        {
          agentId: 'antigravity',
          ...(modern ? { workerStart: true } : {}),
          worktree,
          uncached: true
        },
        expect.any(Number),
        undefined,
        { expectedEnvironmentPairingRevision: 7 }
      )
      expect(effects()).toEqual(before)
      expect(h.runtime.createTerminal).not.toHaveBeenCalled()
    }
  )

  function destination(chat = false) {
    const runtime = Object.assign(
      runtimeStub({ settings: { nativeChatProviders: { antigravity: chat } } }),
      {
        discoverTerminalModels: vi.fn(async () => listing),
        resolveTerminalWorkspaceReadTarget: vi.fn(async () => ({
          scope: {
            id: 'remote-worktree',
            path: '/repo',
            repo: null,
            folderWorkspace: null,
            connectionId: null
          },
          managedWorktree: null
        }))
      }
    )
    const discovery = methodNamed(AGENT_MODEL_DISCOVERY_METHODS, 'agent.discoverTerminalModels')
    const read = (params: unknown) =>
      discovery.handler(discovery.params.parse(params), rpcContext(runtime, {}))
    return { runtime, read }
  }

  function remote() {
    vi.spyOn(h.runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'destination',
      name: 'Destination',
      peerFingerprint: 'peer',
      pairingRevision: 7
    })
    vi.spyOn(h.runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    return vi.spyOn(h.runtime, 'callOrchestrationWorkerServer')
  }

  const remoteArgs = [
    'worker-start',
    '--from',
    'term_coord',
    '--spec',
    'remote check',
    '--on',
    'destination',
    '--worktree',
    'id:remote-worktree',
    ...pair
  ]
  const started = { dispatchId: 'remote-dispatch', state: 'ready', run: { id: 'destination-run' } }

  it.each(['valid', 'chat', 'old', 'unavailable', 'prospective'] as const)(
    'preserves literal remote arguments for %s discovery',
    async (kind) => {
      const dest = destination(kind === 'chat')
      const call = remote().mockImplementation(async (_host, method, params) => {
        if (method === 'status.get') {
          return { capabilities: ORCHESTRATION_RUNTIME_CAPABILITIES }
        }
        if (method === 'agent.discoverTerminalModels') {
          if (kind === 'unavailable') {
            throw new Error('method_not_found')
          }
          return kind === 'old' ? listing : dest.read(params)
        }
        if (method === 'orchestration.workerStart') {
          return started
        }
        if (method === 'orchestration.send') {
          return { delivered: true }
        }
        throw new Error(`Unexpected remote method: ${method}`)
      })
      const args =
        kind === 'prospective'
          ? [
              ...remoteArgs.map((arg) => (arg === 'id:remote-worktree' ? 'new-top-level' : arg)),
              '--repo',
              'id:remote-repo'
            ]
          : kind === 'valid'
            ? remoteArgs.map((value) =>
                value === 'gemini-3.8-flash-high' ? 'gemini-3.8-flash' : value
              )
            : remoteArgs
      expect((await cli(...args)).error).toBeUndefined()
      expect(call).toHaveBeenCalledWith(
        'destination',
        'orchestration.workerStart',
        expect.objectContaining({
          model: kind === 'valid' ? 'gemini-3.8-flash' : 'gemini-3.8-flash-high',
          effort: 'low'
        }),
        expect.any(Number),
        expect.anything(),
        expect.objectContaining({ expectedEnvironmentPairingRevision: 7 })
      )
      if (kind === 'chat') {
        expect(dest.runtime.discoverTerminalModels).not.toHaveBeenCalled()
        expect(dest.runtime.getStructuredAgentSessionCreateSupport).toHaveBeenCalledWith(
          'id:remote-worktree',
          'antigravity',
          { requireInstalledChatProgram: true }
        )
      }
    }
  )

  it.each(['accepted', 'reserved'] as const)(
    'continues the same %s request without a new catalog gate',
    async (state) => {
      const call = remote()
      let reads = 0
      let starts = 0
      call.mockImplementation(async (_host, method) => {
        if (method === 'status.get') {
          return { capabilities: ORCHESTRATION_RUNTIME_CAPABILITIES }
        }
        if (method === 'agent.discoverTerminalModels') {
          reads++
          return {
            ...listing,
            models: starts
              ? [
                  { id: 'gemini-3.8-flash-high', label: 'High' },
                  { id: 'gemini-3.8-flash-medium', label: 'Medium' }
                ]
              : listing.models,
            workerStartMode: 'terminal'
          }
        }
        if (method === 'orchestration.workerStart') {
          starts++
          if (state === 'reserved' && starts === 1) {
            throw Object.assign(new Error('Lost remote reply'), {
              code: 'remote_runtime_unavailable'
            })
          }
          return started
        }
        if (method === 'orchestration.send') {
          return { delivered: true }
        }
        throw new Error(`Unexpected remote method: ${method}`)
      })
      const args = [
        ...remoteArgs.map((value) =>
          value === 'gemini-3.8-flash-high' ? 'gemini-3.8-flash' : value
        ),
        '--retry-request',
        '6f1c2f1e-3a7b-4d55-9c1e-0a1b2c3d4e5f'
      ]
      const first = await cli(...args)
      expect(Boolean(first.error)).toBe(state === 'reserved')
      const second = await cli(...args)
      expect(second.error).toBeUndefined()
      expect(reads).toBe(1)
      expect(starts).toBe(2)
      expect(h.db.listTasks()).toHaveLength(1)
      const task = h.db.listTasks()[0]!
      const retry = await cli(
        'worker-start',
        '--from',
        'term_coord',
        '--task',
        task.id,
        '--retry-of',
        'remote-dispatch',
        '--on',
        'destination',
        '--worktree',
        'id:remote-worktree',
        ...pair
      )
      expect(retry.error?.code).toBe('invalid_argument')
      expect(reads).toBe(2)
      expect((await follow('term_coord', 'remote-dispatch')).error).toBeUndefined()
      expect(reads).toBe(2)
    }
  )
})
