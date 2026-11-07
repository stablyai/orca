import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveWslExecutablePath } from './wsl-executable-path'

/** Only real Windows proves System32 resolution succeeds instead of silently falling back to hijackable PATH. */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('resolveWslExecutablePath on a real Windows host', () => {
  it('resolves an absolute System32 path that exists', () => {
    const resolved = resolveWslExecutablePath()
    // Bare-name fallback means System32 resolution failed and PATH is authoritative again.
    expect(resolved).not.toBe('wsl.exe')
    expect(resolved.toLowerCase()).toContain('system32')
    expect(existsSync(resolved)).toBe(true)
  })
})
