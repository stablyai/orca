import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import { shutdownProviderAndDetectExit } from '../provider/shutdown-detect'
import { getLocalPtyProvider, setLocalPtyProvider } from '../provider/registry'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { stopAndWaitPtysFromRuntimeController } from './stop-and-wait'

const priorProvider = getLocalPtyProvider()
afterEach(() => {
  vi.useRealTimers()
  setLocalPtyProvider(priorProvider)
})

/** A daemon-like provider listing every live terminal for each inventory, as owner resolution does. */
function installProvider(
  terminalCount: number,
  behavior: {
    reportsExit: boolean | ((id: string) => boolean)
    survivesStop?: string
    shutdownMs?: number
    failInventoryAfter?: number
  }
) {
  const live = new Set(Array.from({ length: terminalCount }, (_, index) => `pty-${index}`))
  const exitListeners = new Set<(payload: { id: string; code: number }) => void>()
  const calls = { inventories: 0, shutdowns: 0 }
  const provider = {
    onExit: (listener: (payload: { id: string; code: number }) => void) => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    shutdown: async (id: string) => {
      calls.shutdowns += 1
      // ast-grep-ignore: test-no-real-time-wait -- every test drives this delay with fake timers
      await new Promise((resolve) => setTimeout(resolve, behavior.shutdownMs ?? 0))
      if (id === behavior.survivesStop) {
        return
      }
      live.delete(id)
      const reportsExit =
        typeof behavior.reportsExit === 'function' ? behavior.reportsExit(id) : behavior.reportsExit
      if (reportsExit) {
        for (const listener of exitListeners) {
          listener({ id, code: 0 })
        }
      }
    },
    listProcesses: async () => {
      calls.inventories += 1
      if (
        behavior.failInventoryAfter !== undefined &&
        calls.inventories > behavior.failInventoryAfter
      ) {
        throw new Error('inventory deadline')
      }
      return [...live].map((id) => ({ id, cwd: '/', title: 'claude' }))
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stop path calls only onExit, shutdown and listProcesses
  setLocalPtyProvider(provider as unknown as IPtyProvider)
  return calls
}

const stopDeps = {
  getLocalPtyProviderStartupPromise: () => undefined,
  shutdownProviderAndDetectExit,
  finishPtyShutdown: () => undefined,
  rememberSyntheticKillExit: () => {},
  sendPtyExitToRenderer: () => {}
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stop path reads only these deps; runtime and store are optional
const deps = stopDeps as unknown as PtyRuntimeControllerDeps

describe('batched stop proof', () => {
  it.each([
    [100, 300, true, 1],
    [1_000, 3_000, true, 1],
    // Missed exit events poll absence for 1 s at 100 ms: still per batch, not per stop.
    [100, 300, false, 10],
    [1_000, 3_000, false, 10]
  ])(
    'proves %i stops among %i terminals (exit reported: %s) with %i inventories',
    async (stopCount, terminalCount, reportsExit, inventories) => {
      vi.useFakeTimers()
      const calls = installProvider(terminalCount, { reportsExit, survivesStop: 'pty-7' })
      const ptyIds = Array.from({ length: stopCount }, (_, index) => `pty-${index}`)

      const result = stopAndWaitPtysFromRuntimeController(deps, ptyIds, {
        keepHistory: true,
        concurrency: 8
      })
      await vi.runAllTimersAsync()
      const stopped = await result

      expect(calls.inventories).toBe(inventories)
      expect(stopped.get('pty-7')).toBe(false)
      expect([...stopped.values()].filter(Boolean)).toHaveLength(stopCount - 1)
    }
  )

  it('keeps a proven stop when a later round for a missed exit fails', async () => {
    vi.useFakeTimers()
    installProvider(2, { reportsExit: (id) => id === 'pty-0', failInventoryAfter: 1 })

    const result = stopAndWaitPtysFromRuntimeController(deps, ['pty-0', 'pty-1'], {
      keepHistory: true
    })
    await vi.runAllTimersAsync()

    expect(await result).toEqual(
      new Map([
        ['pty-0', true],
        ['pty-1', false]
      ])
    )
  })

  it.each([100, 1_000])(
    'starts only the first 8 of %i stops when every shutdown outlasts the shutdown deadline',
    async (stopCount) => {
      vi.useFakeTimers({ now: 0 })
      const calls = installProvider(stopCount, { reportsExit: true, shutdownMs: 10_000 })
      const ptyIds = Array.from({ length: stopCount }, (_, index) => `pty-${index}`)

      const result = stopAndWaitPtysFromRuntimeController(deps, ptyIds, {
        keepHistory: true,
        deadlineMs: 4_000,
        shutdownDeadlineMs: 3_500,
        concurrency: 8
      })
      await vi.runAllTimersAsync()
      await result

      expect(calls.shutdowns).toBe(8)
    }
  )
})
