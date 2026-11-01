import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextAutomationOccurrenceAfter } from '../../shared/automation-schedule-occurrences'
import { WslHostService } from '../wsl/wsl-host-service'
import { makeConnector, UBUNTU } from '../wsl/wsl-host-service-test-connector'
import {
  readWslHostAutomationWakes,
  writeWslHostAutomationWakes
} from '../wsl/wsl-host-automation-wake-store'
import type { WslHostAutomationDue, WslHostAutomationWake } from '../wsl/wsl-host-automation-wake'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, ipcMain: { handle: vi.fn() } }))

const { createWslHostAutomationWake } = await import('./wsl-host-automation-wake-wiring')

const HOUR = 60 * 60 * 1000
const HOURLY = '0 * * * *'
// Fixed, mid-hour: only Date is faked, so the wake's real timer still fires.
const NOW = Date.UTC(2026, 10, 1, 8, 30)

function due(nextRunAt: number, lastSeenReadyAt: number): WslHostAutomationDue {
  return {
    nextRunAt,
    wakeUntil: nextRunAt + 12 * HOUR,
    schedules: [{ rrule: HOURLY, dtstart: 0, missedRunGraceMinutes: 720 }],
    lastSeenReadyAt
  }
}

describe('a launch with a stopped WSL host and a saved automation wake (E9)', () => {
  let userDataPath: string
  let wake: WslHostAutomationWake | null = null

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-wake-launch-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  })

  afterEach(() => {
    vi.useRealTimers()
    wake?.dispose()
    wake = null
    rmSync(userDataPath, { recursive: true, force: true })
  })

  // A relaunch: a saved host whose distro is stopped, and a new service with no bridge yet.
  async function launch(saved: WslHostAutomationDue) {
    const connector = makeConnector([UBUNTU])
    const service = new WslHostService({
      userDataPath: () => userDataPath,
      isEnabled: () => true,
      hasServerFiles: () => true,
      publish: () => {},
      pairingChanged: vi.fn(),
      ready: vi.fn(),
      removed: vi.fn()
    })
    service.attach(connector)
    await service.add({ distro: 'Ubuntu' })
    await connector.disconnect('Ubuntu')
    connector.distro.state = 'stopped'
    connector.connect.mockClear()
    writeWslHostAutomationWakes(userDataPath, { 'wsl:ubuntu': saved })
    wake = createWslHostAutomationWake(() => userDataPath, service)
    return connector
  }

  const savedNextRun = (): number | undefined =>
    readWslHostAutomationWakes(userDataPath)['wsl:ubuntu']?.nextRunAt

  it('does not connect, so starts no holder, for a run that came due while the host was last ready', async () => {
    const ranWhileReady = nextAutomationOccurrenceAfter(HOURLY, 0, NOW - 2 * HOUR)
    // Seen ready just now, so no later run has come due since.
    const connector = await launch(due(ranWhileReady, NOW))

    // The launch's fire saves the following run; only then is its decision final.
    await expect.poll(savedNextRun).toBeGreaterThan(NOW)
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('still connects once for a run that came due after the host was last ready', async () => {
    const missed = nextAutomationOccurrenceAfter(HOURLY, 0, NOW - 2 * HOUR)
    const connector = await launch(due(missed, missed - HOUR))

    await expect.poll(() => connector.connect.mock.calls.length).toBe(1)
    expect(connector.connect).toHaveBeenCalledWith('Ubuntu')
  })
})
