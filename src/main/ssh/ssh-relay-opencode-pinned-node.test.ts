import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeRuntimeStore from './orcad-remote-node-runtime'

const mocks = vi.hoisted(() => ({
  target: vi.fn(),
  archive: vi.fn(),
  ensure: vi.fn()
}))
vi.mock('./orcad-deployment-target', () => ({ resolveOrcadDeploymentTargetFacts: mocks.target }))
vi.mock('./pinned-runtime-materializer', () => ({
  materializeNodeRuntimeArchive: mocks.archive
}))
vi.mock('./orcad-remote-node-runtime', async (original) => ({
  ...(await original<typeof NodeRuntimeStore>()),
  ensureRemoteOrcadNodeRuntime: mocks.ensure
}))

import { NODE_RUNTIME_ASSETS, NODE_RUNTIME_COMPAT_ASSETS } from '../../shared/node-runtime-pin'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { preparePinnedNodeForVault } from './ssh-relay-opencode-pinned-node'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every remote call is mocked; the connection is only passed through.
const conn = {} as SshConnection

function prepare(platform: 'linux-x64' | 'win32-x64', exec: (command: string) => Promise<string>) {
  const relayDir = `${platform === 'win32-x64' ? 'C:/Users/ada' : '/home/ada'}/.orca-remote/relay-build`
  return preparePinnedNodeForVault({
    conn,
    host: getRemoteHostPlatform(platform),
    relayDir,
    cacheRoot: '/cache',
    signal: new AbortController().signal,
    exec,
    remote: (operation) => operation()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('pinned Node for the SSH vault reader', () => {
  it.each([
    ['linux-x64', 'linux-x64-glibc', { major: 2, minor: 31 }, '/home/ada', 'bin/node'],
    ['win32-x64', 'win32-x64', null, 'C:/Users/ada', 'node.exe']
  ] as const)(
    'installs the official archive into the shared runtimes/ store on %s hosts',
    async (platform, target, glibc, home, executableName) => {
      const sha = NODE_RUNTIME_ASSETS[target].executableSha256
      const executable = `${home}/.orca-remote/runtimes/node-${sha}/${executableName}`
      mocks.target.mockResolvedValue({ target, glibc })
      mocks.ensure.mockImplementation(async (options) => {
        expect(options).toMatchObject({ slotDir: `${home}/.orca-remote/relay-build`, target })
        await options.archivePath()
        return { executable, transfer: 'uploaded' }
      })
      mocks.archive.mockResolvedValue('/cache/node-archive')

      expect(await prepare(platform, vi.fn())).toEqual({ executable, runtimeSha256: sha })
      expect(mocks.archive).toHaveBeenCalledWith(target, '/cache', expect.any(Object))
    }
  )

  it('fetches no archive when the host store already has a verified runtime', async () => {
    mocks.target.mockResolvedValue({ target: 'win32-x64', glibc: null })
    mocks.ensure.mockResolvedValue({ executable: 'C:/x/node.exe', transfer: 'cached' })
    await prepare('win32-x64', vi.fn())
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it('installs the glibc 2.17 compat Node for the reader on a host below the default floor', async () => {
    const sha = NODE_RUNTIME_COMPAT_ASSETS['linux-x64-glibc217'].executableSha256
    const executable = `/home/ada/.orca-remote/runtimes/node-${sha}/bin/node`
    mocks.target.mockResolvedValue({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 17 } })
    mocks.ensure.mockImplementation(async (options) => {
      expect(options).toMatchObject({ target: 'linux-x64-glibc217' })
      await options.archivePath()
      return { executable, transfer: 'uploaded' }
    })
    mocks.archive.mockResolvedValue('/cache/node-217.tar.gz')

    // The compat sha is the relay dir's store ref, so store GC keeps this runtime.
    expect(await prepare('linux-x64', vi.fn())).toEqual({ executable, runtimeSha256: sha })
    expect(mocks.archive).toHaveBeenCalledWith('linux-x64-glibc217', '/cache', expect.any(Object))
  })

  it('uploads nothing when no Orca-managed Node runs on the host glibc', async () => {
    mocks.target.mockResolvedValue({ target: 'linux-arm64-glibc', glibc: { major: 2, minor: 17 } })

    await expect(prepare('linux-x64', vi.fn())).rejects.toThrow(
      "No Orca-managed Node runs on this host's glibc 2.17"
    )
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.archive).not.toHaveBeenCalled()
  })
})
