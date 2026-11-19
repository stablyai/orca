import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { releaseBotHomeOnServers } from './bots-home-release'

describe("a deleted bot's links on paired servers", () => {
  it('asks every server to release them and shrugs off one that is down or too old', async () => {
    const call = vi.fn(async (id: string, _method: string, _params: unknown, _timeout?: number) => {
      if (id === 'env-down') {
        throw new Error('unreachable')
      }
      return { released: 1 }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fan-out reads only these two.
    const runtime = {
      callOrchestrationWorkerServer: call,
      readStoreInstallationId: async () => 'desktop-install'
    } as unknown as OrcaRuntimeService

    await expect(
      releaseBotHomeOnServers(runtime, 'folder:atlas-home', ['env-a', 'env-down'])
    ).resolves.toBeUndefined()
    expect(call.mock.calls.map(([id, method, params]) => [id, method, params])).toEqual([
      [
        'env-a',
        'worktree.releaseBotHome',
        { botHomeKey: 'folder:atlas-home', installationId: 'desktop-install' }
      ],
      [
        'env-down',
        'worktree.releaseBotHome',
        { botHomeKey: 'folder:atlas-home', installationId: 'desktop-install' }
      ]
    ])
  })
})
