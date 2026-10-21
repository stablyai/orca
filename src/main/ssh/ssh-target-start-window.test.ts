import { describe, expect, it, vi } from 'vitest'
import { SshTargetStartWindow } from './ssh-target-start-window'

function window() {
  const clock = { at: 1_000 }
  const delay = vi.fn(async (_ms: number) => undefined)
  const starts = new SshTargetStartWindow({ now: () => clock.at, delay })
  return { clock, delay, starts }
}

describe('SshTargetStartWindow', () => {
  it('voids an answer heard before the host slept or woke', () => {
    const { clock, starts } = window()
    expect(starts.changedSince('t', 500)).toBe(false)
    starts.noteStopped('t')
    expect(starts.changedSince('t', 900)).toBe(true)
    clock.at = 2_000
    expect(starts.changedSince('t', 1_500)).toBe(false)
    starts.noteStarted('t')
    expect(starts.changedSince('t', 1_500)).toBe(true)
  })

  it('redials only within a minute of a start', async () => {
    const { clock, delay, starts } = window()
    starts.noteStarted('t')
    clock.at += 61_000
    const dial = vi.fn().mockRejectedValue(new Error('Connection reset by 127.0.0.1'))
    await expect(starts.dial('t', dial)).rejects.toThrow()
    expect(dial).toHaveBeenCalledTimes(1)
    expect(delay).not.toHaveBeenCalled()
  })

  it('never redials a refused credential', async () => {
    const { delay, starts } = window()
    starts.noteStarted('t')
    const dial = vi.fn().mockRejectedValue(new Error('Permission denied (publickey).'))
    await expect(starts.dial('t', dial)).rejects.toThrow()
    expect(delay).not.toHaveBeenCalled()
  })
})
