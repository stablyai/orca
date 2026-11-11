import { describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_RUNTIME_CAPABILITIES } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { getFollowUpDispatch } from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
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
    ['id:remote-worktree', []],
    ['new-top-level', ['--repo', 'id:remote-repo']]
  ] as const)('checks %s on its destination before dispatch creation', async (worktree, repo) => {
    vi.spyOn(h.runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'destination',
      name: 'Destination',
      peerFingerprint: 'peer',
      pairingRevision: 7
    })
    const call = vi
      .spyOn(h.runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_host, method) =>
        method === 'status.get' ? { capabilities: ORCHESTRATION_RUNTIME_CAPABILITIES } : listing
      )
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
    expect(result.error).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('--model gemini-3.8-flash --effort low')
    })
    expect(call).toHaveBeenLastCalledWith(
      'destination',
      'agent.discoverTerminalModels',
      {
        agentId: 'antigravity',
        ...(worktree === 'new-top-level'
          ? { repo: 'id:remote-repo', repoHostId: undefined }
          : { worktree }),
        uncached: true
      },
      expect.any(Number),
      undefined,
      { expectedEnvironmentPairingRevision: 7 }
    )
    expect(effects()).toEqual(before)
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
  })
})
