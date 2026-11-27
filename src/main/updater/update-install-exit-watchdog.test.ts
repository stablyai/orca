import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { exit: vi.fn() } }))

import { updateInstallExitTimeoutMs } from './update-install-exit-watchdog'
import {
  finishQuitTeardown,
  quitTeardownDeadlineMs,
  quitWorkerStoreDeadlineMs,
  settleWithinMs
} from '../startup/quit/quit-teardown-deadline'

// Telemetry's shutdown bound (telemetry/client.ts) plus the trace flush bound (observability).
const DIAGNOSTICS_SHUTDOWN_BOUND_MS = 2_500

describe('Windows update exit budget', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // The NSIS check terminates whatever still runs from the install folder once its grace ends;
  // Orca must have exited on its own by then, with room for the installer's own startup.
  it('exits before the installer stops install-folder processes', () => {
    const check = readFileSync(join(process.cwd(), 'config/nsis/orca-process-check.nsh'), 'utf8')
    const grace = Number(/!define ORCA_UPDATE_EXIT_GRACE_MS (\d+)/.exec(check)?.[1])
    expect(grace).toBeGreaterThan(0)
    expect(grace - updateInstallExitTimeoutMs('win32')).toBeGreaterThanOrEqual(2_000)
    expect(updateInstallExitTimeoutMs('darwin')).toBe(20_000)
    expect(updateInstallExitTimeoutMs('linux')).toBe(20_000)
  })

  // The watchdog arms when the install commits, slightly before quit starts, so the data saves
  // keep a 2 s margin under it even when the teardown and the environment store both hang.
  it('finishes the final saves 2 s before the exit watchdog when everything hangs', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    void finishQuitTeardown({
      teardowns: [{ name: 'hung', promise: new Promise(() => {}) }],
      deadlineMs: quitTeardownDeadlineMs(true, 'win32'),
      closeDataStores: async () => {
        events.push(`stores@${Date.now()}`)
      },
      closeWorkerStores: () => new Promise(() => {}),
      workerStoreDeadlineMs: quitWorkerStoreDeadlineMs(true, 'win32'),
      // Diagnostics start only once both store phases have finished.
      shutdownDiagnostics: async () => {
        events.push(`diagnostics@${Date.now()}`)
        await settleWithinMs(new Promise(() => {}), DIAGNOSTICS_SHUTDOWN_BOUND_MS)
      }
    }).then(() => events.push(`quit@${Date.now()}`))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const start = Date.now()

    await vi.advanceTimersByTimeAsync(updateInstallExitTimeoutMs('win32') - 1)

    const at = (name: string): number =>
      Number(events.find((event) => event.startsWith(`${name}@`))?.split('@')[1]) - start
    expect(events.map((event) => event.split('@')[0]).slice(0, 2)).toEqual([
      'stores',
      'diagnostics'
    ])
    expect(at('diagnostics')).toBeLessThanOrEqual(updateInstallExitTimeoutMs('win32') - 2_000)
    expect(quitTeardownDeadlineMs(true, 'darwin')).toBe(20_000)
    expect(quitWorkerStoreDeadlineMs(false, 'win32')).toBe(20_000)
  })

  // #9447: no store may hold quit open forever; a wedged environment-store worker is cut at the
  // quit deadline while the extension stores still save.
  it('quits after the deadline when the environment store never closes', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const events: string[] = []
    void finishQuitTeardown({
      teardowns: [],
      deadlineMs: quitTeardownDeadlineMs(false, 'darwin'),
      closeDataStores: async () => {
        events.push('extension-stores')
      },
      closeWorkerStores: () => new Promise(() => {}),
      workerStoreDeadlineMs: quitWorkerStoreDeadlineMs(false, 'darwin'),
      shutdownDiagnostics: async () => {}
    }).then(() => events.push('quit'))

    await vi.advanceTimersByTimeAsync(quitWorkerStoreDeadlineMs(false, 'darwin') - 1)
    expect(events).toEqual(['extension-stores'])
    await vi.advanceTimersByTimeAsync(1)
    expect(events).toEqual(['extension-stores', 'quit'])
  })
})
