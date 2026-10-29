import { describe, expect, it, vi } from 'vitest'
import { materializeNodeRuntimeArchive } from '../node-runtime/pinned-runtime-materializer'
import { orcadNodeRuntimeInstallOptions } from './orcad-node-runtime-install-options'
import { WSL_NODE_RUNTIME_DOWNLOAD_BUDGET } from '../wsl/wsl-node-runtime-download-budget'

vi.mock('../node-runtime/pinned-runtime-materializer', () => ({
  materializeNodeRuntimeArchive: vi.fn(async () => '/cache/node/archives/node.tar.xz'),
  nodeRuntimeArchiveCachePath: () => '/cache/node/archives/node.tar.xz'
}))

describe('orcadNodeRuntimeInstallOptions', () => {
  it('leaves SSH deploys on the default download timing', async () => {
    const options = orcadNodeRuntimeInstallOptions('linux-x64-glibc', '/cache', {})
    expect(options.nodeRuntimeHostConnectTimeoutSeconds).toBeUndefined()
    await options.nodeRuntimeArchive()
    expect(vi.mocked(materializeNodeRuntimeArchive).mock.lastCall?.[2]).toEqual({
      signal: undefined,
      connectTimeoutMs: undefined
    })
  })

  it('bounds both the desktop and the host download for a WSL deploy', async () => {
    const options = orcadNodeRuntimeInstallOptions('linux-x64-glibc', '/cache', {
      nodeRuntimeDownload: WSL_NODE_RUNTIME_DOWNLOAD_BUDGET
    })
    expect(options.nodeRuntimeHostConnectTimeoutSeconds).toBe(15)
    expect(options.nodeRuntimeOfflineArchivePath).toBe('/cache/node/archives/node.tar.xz')
    await options.nodeRuntimeArchive()
    expect(vi.mocked(materializeNodeRuntimeArchive).mock.lastCall?.[2]).toMatchObject({
      connectTimeoutMs: 15_000
    })
  })

  it('fails a dead network within about 45 s: one desktop attempt, then official and mirror on the host', () => {
    const worstCaseMs =
      WSL_NODE_RUNTIME_DOWNLOAD_BUDGET.desktopConnectTimeoutMs +
      2 * WSL_NODE_RUNTIME_DOWNLOAD_BUDGET.hostConnectTimeoutSeconds * 1000
    expect(worstCaseMs).toBeLessThanOrEqual(45_000)
  })
})
