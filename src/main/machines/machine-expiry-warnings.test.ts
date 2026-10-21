import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MachineExpiryWarning, MachineProviderSnapshot } from '../../shared/machine-inventory'
import { MachineExpiryWarnings, type MachineExpiryWarningDeps } from './machine-expiry-warnings'
import { MachineService } from './machine-service'
import { KEY, removeMachineServiceRoots, setup } from './machine-service.test-fixture'

const NOW = Date.parse('2026-10-19T12:00:00Z')
const MINUTE = 60_000

afterEach(async () => {
  vi.useRealTimers()
  await removeMachineServiceRoots()
})

function snapshot(
  expiresAt: string,
  overrides: Partial<MachineProviderSnapshot> = {}
): MachineProviderSnapshot {
  return {
    providerKey: KEY,
    name: 'Omarchy box',
    pendingCreates: [],
    machines: [
      {
        id: 'sbx-1',
        name: 'pr-2231',
        lifetime: 'temporary',
        state: 'running',
        createdAt: '2026-10-19T10:00:00Z',
        expiresAt,
        providerKey: KEY,
        lastSeenAt: NOW
      }
    ],
    ...overrides
  }
}

function warnings(
  snapshots: MachineProviderSnapshot[],
  log: Pick<MachineExpiryWarningDeps, 'hasWarned' | 'markWarned'>,
  readWorkAtRisk: MachineExpiryWarningDeps['readWorkAtRisk'] = async () => null
) {
  const raised: MachineExpiryWarning[] = []
  const scheduler = new MachineExpiryWarnings({
    snapshots: () => snapshots,
    ...log,
    readWorkAtRisk,
    warn: (warning) => raised.push(warning),
    now: () => Date.now()
  })
  return { scheduler, raised }
}

function memoryLog() {
  const keys = new Set<string>()
  return {
    hasWarned: (key: string) => keys.has(key),
    markWarned: (key: string) => void keys.add(key)
  }
}

describe('MachineExpiryWarnings', () => {
  it('fires 15 minutes before expiry from main alone, with the work it read', async () => {
    vi.useFakeTimers({ now: NOW })
    const { scheduler, raised } = warnings(
      [snapshot('2026-10-19T13:00:00Z')],
      memoryLog(),
      async () => ({
        uncommitted: 1,
        unpushed: 2
      })
    )
    scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(44 * MINUTE)
    expect(raised).toEqual([])
    await vi.advanceTimersByTimeAsync(1 * MINUTE)
    expect(raised).toEqual([
      expect.objectContaining({
        machineId: 'sbx-1',
        expiresAt: Date.parse('2026-10-19T13:00:00Z'),
        workAtRisk: { uncommitted: 1, unpushed: 2 }
      })
    ])
    expect(scheduler.activeWarnings()).toHaveLength(1)
  })

  it("reads expiry on the provider's clock", async () => {
    vi.useFakeTimers({ now: NOW })
    // The provider runs 10 minutes ahead, so its 13:00 is 12:50 here and the warning lands at 12:35.
    const { scheduler, raised } = warnings(
      [snapshot('2026-10-19T13:00:00Z', { clockOffsetMs: 10 * MINUTE })],
      memoryLog()
    )
    scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(35 * MINUTE)
    expect(raised).toHaveLength(1)
    expect(raised[0]?.expiresAt).toBe(Date.parse('2026-10-19T12:50:00Z'))
  })

  it('warns at once inside the window, says unknown work as null, and never for a machine past expiry', async () => {
    vi.useFakeTimers({ now: NOW })
    const inside = warnings([snapshot('2026-10-19T12:10:00Z')], memoryLog())
    inside.scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(0)
    expect(inside.raised).toEqual([expect.objectContaining({ workAtRisk: null })])

    const past = warnings([snapshot('2026-10-19T11:59:00Z')], memoryLog())
    past.scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(past.raised).toEqual([])
  })

  it('does not warn again after a relaunch inside the window', async () => {
    vi.useFakeTimers({ now: NOW })
    const { deps } = await setup({})
    const first = new MachineService(deps)
    const before = warnings([snapshot('2026-10-19T12:10:00Z')], {
      hasWarned: first.expiryWarningLog.has,
      markWarned: first.expiryWarningLog.mark
    })
    before.scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(0)
    expect(before.raised).toHaveLength(1)
    before.scheduler.dispose()

    // A new service reads the same inventory file, as a relaunched app would.
    const relaunched = new MachineService(deps)
    const after = warnings([snapshot('2026-10-19T12:10:00Z')], {
      hasWarned: relaunched.expiryWarningLog.has,
      markWarned: relaunched.expiryWarningLog.mark
    })
    after.scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(after.raised).toEqual([])
  })

  it('warns again when the provider moves the expiry', async () => {
    vi.useFakeTimers({ now: NOW })
    const log = memoryLog()
    const snapshots = [snapshot('2026-10-19T12:10:00Z')]
    const { scheduler, raised } = warnings(snapshots, log)
    scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(0)
    snapshots[0] = snapshot('2026-10-19T12:12:00Z')
    scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(0)
    expect(raised).toHaveLength(2)
  })
})
