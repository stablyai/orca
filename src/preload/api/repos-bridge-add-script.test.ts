import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() } }))

import { reposApi } from './repos-bridge'

describe('repos preload bridge add-script channels', () => {
  beforeEach(() => invoke.mockReset().mockResolvedValue(null))

  it('forwards the opt-in on clone through the same channel', async () => {
    const args = {
      url: 'https://example.com/a.git',
      destination: '/work',
      repositoryAddScriptPreview: { hostId: 'local' as const }
    }

    await reposApi.clone(args)

    expect(invoke).toHaveBeenCalledWith('repos:clone', args)
  })

  it('maps decide and outcome to their narrow channels untouched', async () => {
    const decision = { token: 't', hostId: 'local' as const, repoId: 'r', decision: 'run' as const }

    await reposApi.decideAddScript(decision)
    await reposApi.getAddScriptOutcome({ token: 't', hostId: 'local', repoId: 'r' })

    expect(invoke.mock.calls).toEqual([
      ['repos:decideAddScript', decision],
      ['repos:getAddScriptOutcome', { token: 't', hostId: 'local', repoId: 'r' }]
    ])
  })
})
