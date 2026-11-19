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
  let inventories = 0
  const provider = {
    onExit: (listener: (payload: { id: string; code: number }) => void) => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    shutdown: async (id: string) => {
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
      inventories += 1
      if (
        behavior.failInventoryAfter !== undefined &&
        inventories > behavior.failInventoryAfter
      ) {
        throw new Error('inventory deadline')
      }
      return [...live].map((id) => ({ id, cwd: '/', title: 'claude' }))
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stop path calls only onExit, shutdown and listProcesses
  setLocalPtyProvider(provider as unknown as IPtyProvider)
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

const PTY_IDS = Array.from({ length: 20 }, (_, index) => `pty-${index}`)

describe('batched stop proof', () => {
  it.each([
    ['reported', true],
    ['missed', false]
  ])(
    'proves each stopped PTY of a batch, exit %s, and not the one still listed',
    async (_, reportsExit) => {
      vi.useFakeTimers()
      installProvider(PTY_IDS.length, { reportsExit, survivesStop: 'pty-7' })

      const result = stopAndWaitPtysFromRuntimeController(deps, PTY_IDS, {
        keepHistory: true,
        concurrency: 8
      })
      await vi.runAllTimersAsync()

      expect(await result).toEqual(new Map(PTY_IDS.map((id) => [id, id !== 'pty-7'])))
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

  it('starts no stop after the shutdown deadline', async () => {
    vi.useFakeTimers({ now: 0 })
    installProvider(PTY_IDS.length, { reportsExit: true, shutdownMs: 10_000 })

    const result = stopAndWaitPtysFromRuntimeController(deps, PTY_IDS, {
      keepHistory: true,
      deadlineMs: 4_000,
      shutdownDeadlineMs: 3_500,
      concurrency: 8
    })
    await vi.runAllTimersAsync()

    // Only the first wave started; its shutdowns outlasted the deadline, so no later stop began.
    expect([...(await result).keys()]).toEqual(PTY_IDS.slice(0, 8))
  })
})
