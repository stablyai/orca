import { describe, expect, it, vi } from 'vitest'
import { isWslgSession } from './wslg-session'

describe('isWslgSession', () => {
  it('detects a WSLg session from its runtime mount', () => {
    const exists = vi.fn(() => true)
    expect(isWslgSession({ exists, platform: 'linux' })).toBe(true)
    expect(exists).toHaveBeenCalledWith('/mnt/wslg')
  })

  it('rejects a Linux host without the WSLg mount', () => {
    expect(isWslgSession({ exists: () => false, platform: 'linux' })).toBe(false)
  })

  // Why: the mount cannot exist off Linux, and probing the filesystem there is pure cost.
  it.each(['darwin', 'win32'] as const)('never probes the filesystem on %s', (platform) => {
    const exists = vi.fn(() => true)
    expect(isWslgSession({ exists, platform })).toBe(false)
    expect(exists).not.toHaveBeenCalled()
  })
})
