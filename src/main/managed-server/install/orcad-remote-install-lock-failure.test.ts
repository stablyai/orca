import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadHostTransport } from './orcad-host-transport'
import type { InstallLockWait } from './remote-install-lock'

type InstallLockState = {
  acquireError: Error | null
  acquireOptions: {
    owner?: { token: string }
    waitThroughStaleTakeover?: boolean
    onWait?: (wait: InstallLockWait) => void
  } | null
  uploadError: Error | null
  abandonedWith: ({ fileName: string; token: string } | undefined)[]
  remembered: string[]
  forgotten: string[]
}

const state = vi.hoisted((): InstallLockState => ({
  acquireError: null,
  acquireOptions: null,
  uploadError: null,
  abandonedWith: [],
  remembered: [],
  forgotten: []
}))

vi.mock('./orcad-remote-node-runtime', () => ({ ensureRemoteOrcadNodeRuntime: async () => {} }))
vi.mock('./remote-versioned-install', () => ({
  isRemoteInstallComplete: async () => false,
  abandonInstall: async (
    _conn: unknown,
    _dir: unknown,
    _host: unknown,
    owner?: { fileName: string; token: string }
  ) => {
    state.abandonedWith.push(owner)
    return true
  },
  finalizeInstall: async () => {}
}))
vi.mock('./remote-install-transfers', () => ({
  uploadRemoteInstallDirectory: async () => {
    if (state.uploadError) {
      throw state.uploadError
    }
  },
  writeRemoteInstallFile: async () => {}
}))
vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  execCommand: async () => ''
}))
vi.mock('./remote-install-lock', () => ({
  acquireInstallLock: async (
    _conn: unknown,
    _dir: unknown,
    _host: unknown,
    options: InstallLockState['acquireOptions']
  ) => {
    state.acquireOptions = options
    options?.onWait?.({ takeoverInMs: 60_000, givesUpInMs: 120_000 })
    if (state.acquireError) {
      throw state.acquireError
    }
  }
}))
vi.mock('../activation/orcad-held-fence-tokens', () => ({
  rememberHeldOrcadFence: (token: string) => state.remembered.push(token),
  forgetHeldOrcadFence: (token: string) => state.forgotten.push(token)
}))

const { installOrcadBundle } = await import('./orcad-remote-install')
const { getRemoteHostPlatform } = await import('../../ssh/remote-host/ssh-remote-platform')

// The mocked install steps never read the transport.
const conn: OrcadHostTransport = Object.create(null)

function install(localWslHost = false, onInstallLockWait?: (wait: InstallLockWait | null) => void) {
  return installOrcadBundle(
    {
      conn,
      host: getRemoteHostPlatform('linux-x64'),
      localOrcadDir: '/tmp/orcad',
      target: 'linux-x64-glibc',
      nodeRuntimeArchive: async () => '/tmp/node.tar.xz',
      localWslHost,
      onInstallLockWait
    },
    '0.1.0+aa01',
    '/home/u/.orca-remote/orcad-0.1.0+aa01'
  )
}

describe('installOrcadBundle install-lock handling', () => {
  beforeEach(() => {
    state.acquireError = null
    state.acquireOptions = null
    state.uploadError = null
    state.abandonedWith = []
    state.remembered = []
    state.forgotten = []
  })

  // A lost reply may follow a committed create or steal; the token is a relaunch's only proof.
  it.each([
    ['a confirmed failure', new Error('wsl.exe channel closed')],
    [
      'an unconfirmed termination',
      Object.assign(new Error('closing'), { sshChannelCloseConfirmed: false })
    ]
  ])('keeps its token after %s to acquire', async (_label, error) => {
    state.acquireError = error
    await expect(install()).rejects.toBe(error)
    expect(state.remembered).toHaveLength(1)
    expect(state.forgotten).toEqual([])
    expect(state.abandonedWith).toEqual([])
  })

  it('cleans up only a lock that still names its own token', async () => {
    state.uploadError = new Error('tar: Cannot write')
    await expect(install()).rejects.toThrow('tar: Cannot write')
    const [token] = state.remembered
    expect(state.abandonedWith).toEqual([{ fileName: '.orca-fence-owner', token }])
    expect(state.forgotten).toEqual([token])
  })

  it('waits through to takeover and reports the wait only on a local WSL distro', async () => {
    const waits: (InstallLockWait | null)[] = []
    await install(true, (wait) => waits.push(wait))
    expect(state.acquireOptions?.waitThroughStaleTakeover).toBe(true)
    // The wait clears once the lock is taken.
    expect(waits).toEqual([{ takeoverInMs: 60_000, givesUpInMs: 120_000 }, null])

    waits.length = 0
    await install(false, (wait) => waits.push(wait))
    expect(state.acquireOptions?.waitThroughStaleTakeover).toBeUndefined()
    expect(state.acquireOptions?.onWait).toBeUndefined()
    expect(waits).toEqual([])
  })
})
