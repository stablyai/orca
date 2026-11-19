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
  behavior: { reportsExit: boolean; survivesStop?: string; shutdownMs?: number }
) {
  const live = new Set(Array.from({ length: terminalCount }, (_, index) => `pty-${index}`))
  const exitListeners = new Set<(payload: { id: string; code: number }) => void>()
  const calls = { inventories: 0, shutdowns: 0, maxShuttingDown: 0 }
  let shuttingDown = 0
  const provider = {
    onExit: (listener: (payload: { id: string; code: number }) => void) => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    shutdown: async (id: string) => {
      calls.shutdowns += 1
      shuttingDown += 1
      calls.maxShuttingDown = Math.max(calls.maxShuttingDown, shuttingDown)
      await new Promise((resolve) => setTimeout(resolve, behavior.shutdownMs ?? 0))
      shuttingDown -= 1
      if (id === behavior.survivesStop) {
        return
      }
      live.delete(id)
      if (behavior.reportsExit) {
        for (const listener of exitListeners) {
          listener({ id, code: 0 })
        }
      }
    },
    listProcesses: async () => {
      calls.inventories += 1
      return [...live].map((id) => ({ id, cwd: '/', title: 'claude' }))
    }
  }
  setLocalPtyProvider(provider as unknown as IPtyProvider)
  return calls
}

const deps = {
  getLocalPtyProviderStartupPromise: () => undefined,
  shutdownProviderAndDetectExit,
  finishPtyShutdown: () => undefined,
  rememberSyntheticKillExit: () => {},
  sendPtyExitToRenderer: () => {}
} as unknown as PtyRuntimeControllerDeps

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

  it.each([100, 1_000])(
    'starts at most 8 stops at once and none after the shutdown deadline with %i PTYs',
    async (stopCount) => {
      vi.useFakeTimers({ now: 0 })
      const calls = installProvider(stopCount, { reportsExit: true, shutdownMs: 1_000 })
      const ptyIds = Array.from({ length: stopCount }, (_, index) => `pty-${index}`)

      const result = stopAndWaitPtysFromRuntimeController(deps, ptyIds, {
        keepHistory: true,
        deadlineMs: 3_000,
        shutdownDeadlineMs: 2_500,
        concurrency: 8
      })
      await vi.runAllTimersAsync()
      const stopped = await result

      expect(calls.maxShuttingDown).toBe(8)
      expect(calls.shutdowns).toBe(24)
      expect(stopped.size).toBe(24)
    }
  )
})
