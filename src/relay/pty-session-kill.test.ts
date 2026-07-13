import { describe, expect, it, vi } from 'vitest'
import { killPosixPtySession } from './pty-session-kill'

describe('killPosixPtySession', () => {
  it('targets the full POSIX session with a bounded argument list', async () => {
    const run = vi.fn().mockResolvedValue(undefined)

    await expect(killPosixPtySession(4242, 'linux', run)).resolves.toBe(true)

    expect(run).toHaveBeenCalledWith('pkill', ['-KILL', '-s', '4242'], { timeout: 3000 })
  })

  it('leaves Windows ConPTY teardown to node-pty', async () => {
    const run = vi.fn()

    await expect(killPosixPtySession(4242, 'win32', run)).resolves.toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('falls back cleanly when the session is already empty or pkill is unavailable', async () => {
    const run = vi.fn().mockRejectedValue(new Error('pkill failed'))

    await expect(killPosixPtySession(4242, 'darwin', run)).resolves.toBe(false)
  })
})
