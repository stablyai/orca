import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSocketPath } from './herdr-transport'

// Why: macOS/BSD reject unix socket paths over the ~104-byte sun_path limit
// with EINVAL, which makes the in-app daemon fail to start for deep HOME
// paths (isolated e2e profiles, long usernames). Pin the length fallback.
describe('getDefaultSocketPath', () => {
  const originalXdg = process.env.XDG_RUNTIME_DIR
  const originalHome = process.env.HOME

  afterEach(() => {
    process.env.XDG_RUNTIME_DIR = originalXdg
    process.env.HOME = originalHome
  })

  it('uses the home runtime dir for a short HOME', () => {
    delete process.env.XDG_RUNTIME_DIR
    process.env.HOME = '/home/short'
    expect(getDefaultSocketPath()).toBe('/home/short/.local/share/orca/herdr-daemon.sock')
  })

  it('prefers XDG_RUNTIME_DIR when set', () => {
    process.env.XDG_RUNTIME_DIR = '/run/user/1000'
    process.env.HOME = '/home/short'
    expect(getDefaultSocketPath()).toBe('/run/user/1000/herdr-daemon.sock')
  })

  it('falls back to a short hashed tmpdir path for a deep HOME', () => {
    delete process.env.XDG_RUNTIME_DIR
    const deepHome = join(tmpdir(), 'a'.repeat(80), 'b'.repeat(80), 'home')
    process.env.HOME = deepHome
    const socketPath = getDefaultSocketPath()
    expect(socketPath).not.toContain(deepHome)
    expect(socketPath).toContain('orca-herdr-')
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(104)
    // The fallback must be deterministic for the same HOME so the supervisor
    // and the daemon child agree on the path.
    expect(getDefaultSocketPath()).toBe(socketPath)
  })

  it('never exceeds the socket path limit regardless of HOME', () => {
    delete process.env.XDG_RUNTIME_DIR
    for (const depth of [40, 80, 120, 200]) {
      process.env.HOME = join(tmpdir(), 'x'.repeat(depth), 'home')
      expect(Buffer.byteLength(getDefaultSocketPath())).toBeLessThanOrEqual(104)
    }
    expect(homedir()).toBeTruthy()
  })
})
