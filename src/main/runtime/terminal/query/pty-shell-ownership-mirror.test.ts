import { describe, expect, it, vi } from 'vitest'
import { PtyShellOwnershipMirror } from './pty-shell-ownership-mirror'

describe('PtyShellOwnershipMirror', () => {
  it('asks at the real D after refuted stray Ds, in lockstep with the host barrier', async () => {
    let hostGrounded = false
    const confirm = vi.fn(async () => hostGrounded)
    const mirror = new PtyShellOwnershipMirror(confirm)
    mirror.scan('\x1b]133;C\x07\x1b[>1u\x1b[?1049hAGENT')

    for (let index = 1; index <= 5; index += 1) {
      mirror.scan('\x1b]133;C\x07nested\x1b]133;D;0\x07')
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(index))
      await mirror.settle()
    }
    hostGrounded = true
    mirror.scan('\x1b]133;D;137\x07')

    await vi.waitFor(() => expect(mirror.owner).toBe('shell'))
    expect(confirm).toHaveBeenCalledTimes(6)
  })

  it('contains a synchronously throwing confirm callback', async () => {
    let calls = 0
    const mirror = new PtyShellOwnershipMirror(() => {
      calls += 1
      if (calls === 1) {
        throw new Error('sync boom')
      }
      return Promise.resolve(true)
    })
    mirror.seedOwner(undefined, { alternateScreen: true })
    expect(() => mirror.scan('\x1b]133;D;137\x07')).not.toThrow()
    await mirror.settle()
    expect(mirror.owner).toBeUndefined()

    mirror.scan('\x1b[?1049hTUI\x1b]133;D;137\x07')
    await vi.waitFor(() => expect(calls).toBe(2))
    await mirror.settle()
    expect(mirror.owner).toBe('shell')
  })
})
