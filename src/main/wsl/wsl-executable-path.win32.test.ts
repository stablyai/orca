import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveWslExecutablePath } from './wsl-executable-path'

/**
 * The one thing about the runner that only a real Windows host can answer:
 * does `wsl.exe` actually live where we resolve it, or are we silently falling
 * back to bare-name PATH resolution -- the hijack this exists to prevent?
 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('resolveWslExecutablePath on a real Windows host', () => {
  it('resolves an absolute System32 path that exists', () => {
    const resolved = resolveWslExecutablePath()
    // A bare 'wsl.exe' here means the System32 probe missed and every WSL call
    // is back to PATH resolution.
    expect(resolved).not.toBe('wsl.exe')
    expect(resolved.toLowerCase()).toContain('system32')
    expect(existsSync(resolved)).toBe(true)
  })

  it('memoises, so a spawn does not pay a stat', () => {
    expect(resolveWslExecutablePath()).toBe(resolveWslExecutablePath())
  })
})
