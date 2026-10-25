import { describe, expect, it } from 'vitest'
import { NativeDesktopNotifierReadiness } from './native-desktop-notifier-readiness'

describe('native desktop notifier readiness', () => {
  it('keeps a surviving document ready when its first ping arrives during a cancelled navigation', () => {
    const readiness = new NativeDesktopNotifierReadiness()
    readiness.beginReloadFence(12)
    readiness.markReady(12)
    readiness.buffer(12, 'reposChanged', [])
    expect(readiness.restoreReady(12)).toEqual([{ method: 'reposChanged', args: [] }])
    expect(readiness.isReady(12)).toBe(true)
  })

  it('starts unready and reports nothing pending until a broadcast is missed', () => {
    const readiness = new NativeDesktopNotifierReadiness()
    expect(readiness.isReady(1)).toBe(false)
    expect(readiness.markReady(1)).toEqual([])
  })

  it('retains every distinct broadcast in arrival order, even repeats of the same method', () => {
    const readiness = new NativeDesktopNotifierReadiness()
    readiness.buffer(1, 'reposChanged', [])
    readiness.buffer(1, 'worktreesChanged', ['repo-1'])
    readiness.buffer(1, 'worktreesChanged', ['repo-2'])
    expect(readiness.markReady(1)).toEqual([
      { method: 'reposChanged', args: [] },
      { method: 'worktreesChanged', args: ['repo-1'] },
      { method: 'worktreesChanged', args: ['repo-2'] }
    ])
  })

  it('clears the buffer only once the caller confirms delivery, so an unsettled flush is retried', () => {
    const readiness = new NativeDesktopNotifierReadiness()
    readiness.buffer(1, 'reposChanged', [])
    const firstAttempt = readiness.markReady(1)
    // The caller could not deliver (e.g. the sender was still unavailable) and never settles.
    expect(readiness.markReady(1)).toEqual([{ method: 'reposChanged', args: [] }])
    readiness.settleFlush(1, firstAttempt)
    expect(readiness.markReady(1)).toEqual([])
  })

  it('restores exactly the readiness a reload fence captured, not an unconditional true', () => {
    const readiness = new NativeDesktopNotifierReadiness()
    // Never pinged ready before the fence opened.
    readiness.beginReloadFence(2)
    expect(readiness.restoreReady(2)).toEqual([])
    expect(readiness.isReady(2)).toBe(false)

    readiness.markReady(3)
    readiness.beginReloadFence(3)
    expect(readiness.isReady(3)).toBe(false)
    readiness.buffer(3, 'reposChanged', [])
    expect(readiness.restoreReady(3)).toEqual([{ method: 'reposChanged', args: [] }])
    expect(readiness.isReady(3)).toBe(true)
  })

  it('drops a stale fence once a genuine new document supersedes it', () => {
    const readiness = new NativeDesktopNotifierReadiness()
    readiness.markReady(4)
    readiness.beginReloadFence(4)
    // The reload actually committed before its own cancellation handler ran.
    readiness.markUnready(4)
    expect(readiness.restoreReady(4)).toEqual([])
    expect(readiness.isReady(4)).toBe(false)
  })

  it('forgets a closed window completely, including any buffered replay', () => {
    const readiness = new NativeDesktopNotifierReadiness()
    readiness.markReady(5)
    readiness.buffer(5, 'reposChanged', [])
    readiness.forget(5)
    expect(readiness.isReady(5)).toBe(false)
    expect(readiness.markReady(5)).toEqual([])
  })

  it('requires recovery instead of replaying a truncated queue after overflow', () => {
    const readiness = new NativeDesktopNotifierReadiness()
    for (let i = 0; i < 200; i += 1) {
      readiness.buffer(6, 'worktreesChanged', [`repo-${i}`])
    }
    const pending = readiness.markReady(6)
    expect(pending).toEqual([])
    expect(readiness.needsRecovery(6)).toBe(true)
    readiness.settleRecovery(6)
    expect(readiness.needsRecovery(6)).toBe(false)
    expect(readiness.isReady(6)).toBe(false)
    readiness.buffer(6, 'reposChanged', [])
    expect(readiness.markReady(6)).toEqual([{ method: 'reposChanged', args: [] }])
  })

  it('tracks each window independently', () => {
    const readiness = new NativeDesktopNotifierReadiness()
    readiness.markReady(7)
    readiness.buffer(8, 'reposChanged', [])
    expect(readiness.isReady(7)).toBe(true)
    expect(readiness.isReady(8)).toBe(false)
    expect(readiness.markReady(8)).toEqual([{ method: 'reposChanged', args: [] }])
  })
})
