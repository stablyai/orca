import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadHostTransport } from './orcad-host-transport'

type HolderInstallState = {
  events: string[]
  uploadConn: unknown
  holderAvailable: boolean
  loseHolderDuringUpload: boolean
  loseHolder: () => void
  acquireOptions: { probeExitedHolder?: boolean } | null
}

const state = vi.hoisted((): HolderInstallState => ({
  events: [],
  uploadConn: null,
  holderAvailable: true,
  loseHolderDuringUpload: false,
  loseHolder: () => {},
  acquireOptions: null
}))

vi.mock('./orcad-remote-node-runtime', () => ({ ensureRemoteOrcadNodeRuntime: async () => {} }))
vi.mock('./remote-versioned-install', () => ({
  isRemoteInstallComplete: async () => false,
  abandonInstall: async (conn: { fenced?: string }) => {
    state.events.push(`abandon:${conn.fenced ? 'fenced' : 'plain'}`)
    return true
  },
  finalizeInstall: async (conn: { fenced?: string }) => {
    state.events.push(`finalize:${conn.fenced ? 'fenced' : 'plain'}`)
  }
}))
vi.mock('./remote-install-transfers', () => ({
  uploadRemoteInstallDirectory: async (
    conn: unknown,
    _local: unknown,
    _remote: unknown,
    _host: unknown,
    options: { signal?: AbortSignal }
  ) => {
    state.uploadConn = conn
    if (state.loseHolderDuringUpload) {
      state.loseHolder()
      await Promise.resolve()
      options.signal?.throwIfAborted()
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
    options: { probeExitedHolder?: boolean }
  ) => {
    state.acquireOptions = options
  }
}))
vi.mock('./remote-install-lock-holder', () => ({
  startInstallLockHolder: async () => {
    if (!state.holderAvailable) {
      return null
    }
    let resolveLost: () => void = () => {}
    const lost = new Promise<void>((resolve) => (resolveLost = resolve))
    state.loseHolder = resolveLost
    return { lost, release: () => state.events.push('release') }
  }
}))
vi.mock('../activation/orcad-held-fence-tokens', () => ({
  rememberHeldOrcadFence: () => {},
  forgetHeldOrcadFence: () => {}
}))

const { installOrcadBundle } = await import('./orcad-remote-install')
const { getRemoteHostPlatform } = await import('../../ssh/remote-host/ssh-remote-platform')

function wslConn(): OrcadHostTransport {
  const conn: OrcadHostTransport = Object.create(null)
  return Object.assign(conn, {
    withCommandFence: (fence: string) => Object.assign(Object.create(null), { fenced: fence })
  })
}

function install(conn: OrcadHostTransport, localWslHost = true) {
  return installOrcadBundle(
    {
      conn,
      host: getRemoteHostPlatform('linux-x64'),
      localOrcadDir: '/tmp/orcad',
      target: 'linux-x64-glibc',
      nodeRuntimeArchive: async () => '/tmp/node.tar.xz',
      localWslHost
    },
    '0.1.0+aa01',
    '/home/u/.orca-remote/orcad-0.1.0+aa01'
  )
}

describe('installOrcadBundle flock-backed install lock on WSL', () => {
  beforeEach(() => {
    state.events = []
    state.uploadConn = null
    state.holderAvailable = true
    state.loseHolderDuringUpload = false
    state.acquireOptions = null
  })

  it('fences every install command on the holder and releases it after cleanup', async () => {
    await expect(install(wslConn())).resolves.toBe('uploaded')
    expect(state.acquireOptions?.probeExitedHolder).toBe(true)
    expect(state.uploadConn).toMatchObject({ fenced: expect.stringContaining('flock -s -n 7') })
    expect(state.events).toEqual(['finalize:fenced', 'abandon:fenced', 'release'])
  })

  it('stops the install when its holder exits mid-install', async () => {
    state.loseHolderDuringUpload = true
    await expect(install(wslConn())).rejects.toThrow('The install lock holder exited.')
    expect(state.events).toEqual(['abandon:fenced', 'release'])
  })

  it('keeps an unbacked lock where the distro cannot hold one', async () => {
    state.holderAvailable = false
    await expect(install(wslConn())).resolves.toBe('uploaded')
    expect(state.uploadConn).not.toHaveProperty('fenced')
    expect(state.events).toEqual(['finalize:plain', 'abandon:plain'])
  })

  it('leaves SSH installs unbacked and unprobed', async () => {
    await expect(install(wslConn(), false)).resolves.toBe('uploaded')
    expect(state.acquireOptions?.probeExitedHolder).toBeUndefined()
    expect(state.uploadConn).not.toHaveProperty('fenced')
  })
})
