import { describe, expect, it, vi } from 'vitest'
import { createWindowQuitLifecycle } from './window-quit-lifecycle'

describe('window quit lifecycle', () => {
  it('fences transfers before freezing session retirement and later side effects', () => {
    const calls: string[] = []
    const lifecycle = createWindowQuitLifecycle({
      fenceTransfers: () => {
        calls.push('fence-transfers')
        return Promise.resolve()
      },
      freezeSessions: () => calls.push('freeze-sessions'),
      resumeTransfers: vi.fn(),
      resumeSessions: vi.fn()
    })

    expect(lifecycle.isActive()).toBe(false)
    lifecycle.begin()
    expect(lifecycle.isActive()).toBe(true)
    calls.push('later-side-effect')

    expect(calls).toEqual(['fence-transfers', 'freeze-sessions', 'later-side-effect'])
  })

  it('is idempotent until abort then resumes only the quit-owned fences', () => {
    const fenceTransfers = vi.fn(() => Promise.resolve())
    const freezeSessions = vi.fn()
    const resumeTransfers = vi.fn()
    const resumeSessions = vi.fn()
    const lifecycle = createWindowQuitLifecycle({
      fenceTransfers,
      freezeSessions,
      resumeTransfers,
      resumeSessions
    })

    expect(lifecycle.begin()).toBe(lifecycle.begin())
    expect(fenceTransfers).toHaveBeenCalledOnce()
    expect(freezeSessions).toHaveBeenCalledOnce()

    lifecycle.abort()
    expect(lifecycle.isActive()).toBe(false)
    expect(resumeTransfers).toHaveBeenCalledOnce()
    expect(resumeSessions).toHaveBeenCalledOnce()

    lifecycle.begin()
    expect(fenceTransfers).toHaveBeenCalledTimes(2)
    expect(freezeSessions).toHaveBeenCalledTimes(2)
  })
})
