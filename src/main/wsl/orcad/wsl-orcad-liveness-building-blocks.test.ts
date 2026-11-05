import { afterEach, describe, expect, it, vi } from 'vitest'
import { gatherWslLivenessEvidence } from './wsl-orcad-liveness-evidence'

import { attachSupervisedWatch, cancellableWait, subscribeWake } from './wsl-orcad-liveness-monitor'

import { disarmSupervised, newSupervised, type WslOrcadTimer } from './wsl-orcad-liveness-state'
import { WslOrcadReconnectBackoff } from './wsl-orcad-reconnect-backoff'
import type { WslOrcadWatch } from './wsl-orcad-watch'

// Pins the supervisor's building blocks one by one; the supervisor suite covers them together.
const backoff = new WslOrcadReconnectBackoff(() => 0)

function fakeWatch(signal: WslOrcadWatch['signal']) {
  let exit: ((code: number | null) => void) | null = null
  const watch = {
    signal,
    onExit: vi.fn((listener: (code: number | null) => void) => {
      exit = listener
    }),
    close: vi.fn(),
    proving: () => signal === 'ready',
    exit: (code: number | null) => exit?.(code)
  }
  return watch
}

describe('WSL orcad liveness building blocks', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('asks identity first and the port only when identity cannot decide', async () => {
    const asked: string[] = []
    const evidence = await gatherWslLivenessEvidence(
      {
        trigger: { source: 'bridge', code: 0 },
        running: { status: 'confirmed', running: true },
        expected: { distroInstance: 'boot-1', orcad: 'pid-1' }
      },
      {
        readIdentity: async () => {
          asked.push('identity')
          return { distroInstance: 'boot-1', orcad: null }
        },
        probePort: async () => {
          asked.push('port')
          return 'refused'
        }
      }
    )
    expect(asked).toEqual(['identity'])
    expect(evidence.identity).toEqual({ distroInstance: 'boot-1', orcad: null })
    const stopped = await gatherWslLivenessEvidence(
      {
        trigger: { source: 'verify' },
        running: { status: 'confirmed', running: false },
        expected: { distroInstance: null, orcad: null }
      },
      {
        readIdentity: async () => {
          throw new Error('must not boot a stopped distro')
        },
        probePort: async () => 'refused'
      }
    )
    expect(stopped.identity).toBeUndefined()
  })

  it('reports a resume only after subscribing, and a suspend always', () => {
    const changes: boolean[] = []
    const unsubscribe = vi.fn()
    let resume = (): void => {}
    const stop = subscribeWake(
      (listener) => {
        listener.onResume()
        listener.onSuspend()
        resume = listener.onResume
        return unsubscribe
      },
      (suspended) => changes.push(suspended)
    )
    expect(changes).toEqual([true])
    resume()
    expect(changes).toEqual([true, false])
    stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(subscribeWake(undefined, () => {})).toBeTypeOf('function')
  })

  it('ends a backoff wait early when the entry is disarmed, closing its watch', async () => {
    const entry = newSupervised('Ubuntu', 'ubuntu', 0, backoff)
    const cancel = vi.fn()
    const schedule = (_delayMs: number, _task: () => void): WslOrcadTimer => ({ cancel })
    const wait = cancellableWait(entry, schedule, 1_000)
    const watch = fakeWatch('ready')
    entry.watch = watch
    disarmSupervised(entry)
    await wait
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(watch.close).toHaveBeenCalledTimes(1)
    expect(entry).toMatchObject({ timer: null, wakeWait: null, watch: null })
  })

  it('holds a ready watch, drops one a later connect superseded, and reports its exit once', async () => {
    const entry = newSupervised('Ubuntu', 'ubuntu', 0, backoff)
    const onExit = vi.fn()
    const refused = fakeWatch('refused')
    await expect(attachSupervisedWatch(entry, async () => refused, onExit)).resolves.toBe('refused')
    expect(entry.watch).toBeNull()

    const superseded = fakeWatch('ready')
    await expect(
      attachSupervisedWatch(
        entry,
        async () => {
          entry.generation += 1
          return superseded
        },
        onExit
      )
    ).resolves.toBe('ready')
    expect(superseded.close).toHaveBeenCalledTimes(1)
    expect(entry.watch).toBeNull()

    const held = fakeWatch('ready')
    await attachSupervisedWatch(entry, async () => held, onExit)
    expect(entry.watch).toBe(held)
    held.exit(1)
    held.exit(2)
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledWith(1)
    expect(entry.watch).toBeNull()
  })
})
