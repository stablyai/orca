import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'

const pass = vi.hoisted(() => ({ run: vi.fn<() => Promise<void>>() }))
vi.mock('./wsl-move-desktop-rewrite', () => ({ runWslMoveDesktopRewritePass: pass.run }))

const { runWslMoveStartupRewrite, WSL_MOVE_STARTUP_REWRITE_WAIT_MS } =
  await import('./wsl-move-startup-rewrite')

beforeEach(() => {
  pass.run.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('WSL move startup rewrite', () => {
  it('neither runs the pass nor waits with the gate closed', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    const recover = vi.fn(async () => {})
    await runWslMoveStartupRewrite({ userDataPath: '/data' }, { recover })
    expect(recover).not.toHaveBeenCalled()
    expect(pass.run).not.toHaveBeenCalled()
  })

  it('resets an interrupted move before the pass, and still runs the pass if that fails', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    const order: string[] = []
    pass.run.mockImplementation(async () => {
      order.push('pass')
    })
    await runWslMoveStartupRewrite(
      { userDataPath: '/data' },
      {
        recover: async () => {
          order.push('recover')
        }
      }
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runWslMoveStartupRewrite(
      { userDataPath: '/data' },
      {
        recover: async () => {
          order.push('recover-failed')
          throw new Error('journal unreadable')
        }
      }
    )
    expect(order).toEqual(['recover', 'pass', 'recover-failed', 'pass'])
  })

  it('resolves once the pass finishes', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    let finish: () => void = () => {}
    pass.run.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    let done = false
    const waiting = runWslMoveStartupRewrite({ userDataPath: '/data' }).then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    finish()
    await waiting
    expect(pass.run).toHaveBeenCalledWith({ userDataPath: '/data' })
  })

  it('stops waiting for a hung pass at the bound', async () => {
    vi.useFakeTimers()
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    pass.run.mockReturnValue(new Promise<void>(() => {}))
    let done = false
    void runWslMoveStartupRewrite({ userDataPath: '/data' }).then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(WSL_MOVE_STARTUP_REWRITE_WAIT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })
})
