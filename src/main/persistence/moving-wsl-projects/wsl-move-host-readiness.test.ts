import { describe, expect, it, vi } from 'vitest'
import { prepareWslMoveHost, type WslMoveHostReadinessDeps } from './wsl-move-host-readiness'

function deps(overrides: Partial<WslMoveHostReadinessDeps> = {}): WslMoveHostReadinessDeps {
  let ready = false
  return {
    readRunningDistros: async () => ({ status: 'confirmed', distros: ['Ubuntu'] }),
    isHostReady: () => ready,
    removalPending: () => false,
    hasHost: () => false,
    connect: vi.fn(async () => {
      ready = true
    }),
    add: vi.fn(async () => {
      ready = true
      return { ok: true as const, environmentId: 'wsl:Ubuntu' }
    }),
    ...overrides
  }
}

describe('prepareWslMoveHost (A1)', () => {
  it('touches nothing when the running-distro read fails or throws', async () => {
    const unavailable = deps({ readRunningDistros: async () => ({ status: 'unavailable' }) })
    expect(await prepareWslMoveHost(unavailable, 'Ubuntu')).toBe('unverifiable')
    const throwing = deps({
      readRunningDistros: async () => {
        throw new Error('wsl.exe hung')
      }
    })
    expect(await prepareWslMoveHost(throwing, 'Ubuntu')).toBe('unverifiable')
    expect(unavailable.add).not.toHaveBeenCalled()
    expect(throwing.connect).not.toHaveBeenCalled()
  })

  it('never connects or adds a host for a stopped distro', async () => {
    const stopped = deps({ hasHost: () => true })
    expect(await prepareWslMoveHost(stopped, 'Debian')).toBe('not-running')
    expect(stopped.connect).not.toHaveBeenCalled()
    expect(stopped.add).not.toHaveBeenCalled()
  })

  it('re-reads the pending Remove after the running-distro read', async () => {
    let removing = false
    const racing = deps({
      readRunningDistros: async () => {
        removing = true
        return { status: 'confirmed', distros: ['Ubuntu'] }
      },
      removalPending: () => removing
    })
    expect(await prepareWslMoveHost(racing, 'Ubuntu')).toBe('failed')
    expect(racing.add).not.toHaveBeenCalled()
  })

  // Re-review: a Remove that completes during the running-distro read must not be undone by an add.
  it('adds no host once the distro stopped being wanted during the read', async () => {
    let wanted = true
    const racing = deps({
      readRunningDistros: async () => {
        wanted = false
        return { status: 'confirmed', distros: ['Ubuntu'] }
      }
    })
    expect(await prepareWslMoveHost(racing, 'Ubuntu', () => wanted)).toBe('failed')
    expect(racing.add).not.toHaveBeenCalled()
    expect(racing.connect).not.toHaveBeenCalled()
  })
})
