import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadHostTransport } from './orcad-host-transport'

type HolderInstallState = {
  events: string[]
  uploadConn: unknown
  holderAvailable: boolean
  holderFenceable: boolean
  uploadError: Error | null
  abandonConfirmed: boolean
  forgotten: string[]
  loseHolderDuringUpload: boolean
  callerAbort: AbortController | null
  lostUploadError: Error | null
  loseHolder: () => void
  acquireOptions: { probeExitedHolder?: boolean } | null
}

const state = vi.hoisted((): HolderInstallState => ({
  events: [],
  uploadConn: null,
  holderAvailable: true,
  holderFenceable: false,
  uploadError: null,
  abandonConfirmed: true,
  forgotten: [],
  loseHolderDuringUpload: false,
  callerAbort: null,
  lostUploadError: null,
  loseHolder: () => {},
  acquireOptions: null
}))

vi.mock('./orcad-remote-node-runtime', () => ({ ensureRemoteOrcadNodeRuntime: async () => {} }))
vi.mock('./remote-versioned-install', () => ({
  isRemoteInstallComplete: async () => false,
  abandonInstall: async (
    conn: { fenced?: string },
    _dir: unknown,
    _host: unknown,
    _owner: unknown,
    gate?: string
  ) => {
    state.events.push(`abandon:${conn.fenced ? 'fenced' : 'plain'}${gate ? ':gated' : ''}`)
    return state.abandonConfirmed
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
    if (state.uploadError) {
      throw state.uploadError
    }
    if (state.loseHolderDuringUpload) {
      state.loseHolder()
      state.callerAbort?.abort()
      await Promise.resolve()
      // Transports drop the abort reason for a generic cancel.
      if (options.signal?.aborted) {
        throw state.lostUploadError ?? createSshOperationAbortError()
      }
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
      return { holder: null, fenceable: state.holderFenceable }
    }
    let resolveLost: () => void = () => {}
    const lost = new Promise<void>((resolve) => (resolveLost = resolve))
    state.loseHolder = resolveLost
    let released = false
    // Idempotent, like the real holder.
    const release = (): void => {
      if (!released) {
        released = true
        state.events.push('release')
      }
    }
    return { holder: { lost, release } }
  }
}))
vi.mock('../activation/orcad-held-fence-tokens', () => ({
  rememberHeldOrcadFence: () => {},
  forgetHeldOrcadFence: (token: string) => state.forgotten.push(token)
}))

const { installOrcadBundle, OrcadInstallTakenOverError } = await import('./orcad-remote-install')
const { sshCommandExitError } = await import('../../ssh/remote-exec/remote-exec-command')
const { createSshOperationAbortError } = await import('../../ssh/connection/ssh-exec-options')
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
      localWslHost,
      signal: state.callerAbort?.signal
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
    state.holderFenceable = false
    state.uploadError = null
    state.abandonConfirmed = true
    state.forgotten = []
    state.loseHolderDuringUpload = false
    state.callerAbort = null
    state.lostUploadError = null
    state.acquireOptions = null
  })

  it('fences every install command, then releases the holder before a gated lock removal', async () => {
    await expect(install(wslConn())).resolves.toBe('uploaded')
    expect(state.acquireOptions?.probeExitedHolder).toBe(true)
    expect(state.uploadConn).toMatchObject({ fenced: expect.stringContaining('flock -s -n 7') })
    expect(state.events).toEqual(['finalize:fenced', 'release', 'abandon:plain:gated'])
  })

  it('stops the install when its holder exits mid-install', async () => {
    state.loseHolderDuringUpload = true
    await expect(install(wslConn())).rejects.toThrow(/Orca lost track of its own install/)
    expect(state.events).toEqual(['release', 'abandon:plain:gated'])
  })

  it('keeps a more specific failure when the holder is lost with it', async () => {
    state.loseHolderDuringUpload = true
    state.lostUploadError = sshCommandExitError('tar -x', 1, 'the distro was terminated')
    await expect(install(wslConn())).rejects.toThrow(/the distro was terminated/)
  })

  it('reports the caller own cancel, not a lost holder, when both happen', async () => {
    state.loseHolderDuringUpload = true
    state.callerAbort = new AbortController()
    await expect(install(wslConn())).rejects.toThrow('SSH operation was cancelled')
  })

  it('keeps its token when the gated removal gives up', async () => {
    state.abandonConfirmed = false
    await expect(install(wslConn())).resolves.toBe('uploaded')
    expect(state.forgotten).toEqual([])
  })

  it('still fences an install whose holder never confirmed it held the lock', async () => {
    state.holderAvailable = false
    state.holderFenceable = true
    await expect(install(wslConn())).resolves.toBe('uploaded')
    expect(state.uploadConn).toMatchObject({ fenced: expect.stringContaining('flock -s -n 7') })
    expect(state.events).toEqual(['finalize:fenced', 'abandon:plain:gated'])
  })

  it('says another window took over when a fenced command exits 75, and leaves its lock alone', async () => {
    state.uploadError = sshCommandExitError('tar -x', 75, '')
    const failure = install(wslConn())
    await expect(failure).rejects.toBeInstanceOf(OrcadInstallTakenOverError)
    await expect(failure).rejects.toThrow(/Another Orca window took over/)
    expect(state.events).toEqual(['release'])
  })

  it('keeps other fenced failures as they are', async () => {
    state.uploadError = sshCommandExitError('tar -x', 2, 'disk full')
    await expect(install(wslConn())).rejects.toThrow(/exit 2/)
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
