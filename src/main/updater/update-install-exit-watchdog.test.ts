import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { exit: vi.fn() } }))

import { updateInstallExitTimeoutMs } from './update-install-exit-watchdog'
import {
  finishQuitTeardown,
  quitTeardownDeadlineMs,
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

  it('saves the final stores before the exit watchdog even when a teardown hangs', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    void finishQuitTeardown({
      teardowns: [{ name: 'hung', promise: new Promise(() => {}) }],
      deadlineMs: quitTeardownDeadlineMs(true, 'win32'),
      closeDataStores: async () => {
        events.push(`stores@${Date.now()}`)
      },
      closeWorkerStores: async () => {},
      // Telemetry and the trace sink each bound their flush; model one that never answers.
      shutdownDiagnostics: async () => {
        events.push(`diagnostics@${Date.now()}`)
        await settleWithinMs(new Promise(() => {}), DIAGNOSTICS_SHUTDOWN_BOUND_MS)
      }
    }).then(() => events.push(`quit@${Date.now()}`))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const start = Date.now()

    // Everything must have happened before the watchdog would call app.exit(0).
    await vi.advanceTimersByTimeAsync(updateInstallExitTimeoutMs('win32') - 1)

    const at = (name: string): number =>
      Number(events.find((event) => event.startsWith(`${name}@`))?.split('@')[1]) - start
    expect(events.map((event) => event.split('@')[0])).toEqual(['stores', 'diagnostics', 'quit'])
    expect(at('quit')).toBeLessThan(updateInstallExitTimeoutMs('win32'))
    expect(quitTeardownDeadlineMs(true, 'darwin')).toBe(20_000)
    expect(quitTeardownDeadlineMs(false, 'win32')).toBe(20_000)
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
      shutdownDiagnostics: async () => {}
    }).then(() => events.push('quit'))

    await vi.advanceTimersByTimeAsync(quitTeardownDeadlineMs(false, 'darwin') - 1)
    expect(events).toEqual(['extension-stores'])
    await vi.advanceTimersByTimeAsync(1)
    expect(events).toEqual(['extension-stores', 'quit'])
  })
})
