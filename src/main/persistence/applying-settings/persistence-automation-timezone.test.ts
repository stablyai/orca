import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  readDataFile,
  makeRepo
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { nextAutomationOccurrenceAfter } from '../../../shared/automations/scheduling/automation-schedule-occurrences'
import type { Store } from '../loading-store/store'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

describe('automation schedules in their own timezone', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  const DAILY_NINE = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'
  const DTSTART = new Date('2026-05-01T00:00:00Z').getTime()
  const iso = (at: number) => new Date(at).toISOString()

  // Zones no test host uses: one west and one east of every host.
  function create(
    store: Store,
    timezone: string,
    timezoneExplicit?: true
  ): ReturnType<Store['createAutomation']> {
    return store.createAutomation({
      name: timezone,
      prompt: 'Summarize',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone,
      ...(timezoneExplicit ? { timezoneExplicit } : {}),
      rrule: DAILY_NINE,
      dtstart: DTSTART
    })
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-05-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("follows a desktop's own clock for the zone captured at creation, like an alarm", async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const hostClock = nextAutomationOccurrenceAfter(DAILY_NINE, DTSTART, Date.now())

    const automation = create(store, 'Pacific/Kiritimati')
    // The editor resends its own zone on every save; that names nothing.
    const saved = store.updateAutomation(automation.id, {
      name: 'Renamed',
      timezone: 'Pacific/Honolulu'
    })

    expect(automation.nextRunAt).toBe(hostClock)
    expect(saved.nextRunAt).toBe(hostClock)
    expect(saved.timezoneExplicit).toBeUndefined()
  })

  it('holds a zone the owner named on a desktop, through an editor save', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const london = create(store, 'Europe/London', true)
    const saved = store.updateAutomation(london.id, { name: 'x', timezone: 'Pacific/Honolulu' })
    const tokyo = store.updateAutomation(london.id, {
      timezone: 'Asia/Tokyo',
      timezoneExplicit: true
    })

    expect(iso(london.nextRunAt)).toBe('2026-05-14T08:00:00.000Z')
    expect(saved).toMatchObject({ timezone: 'Europe/London', timezoneExplicit: true })
    expect(saved.nextRunAt).toBe(london.nextRunAt)
    expect(iso(tokyo.nextRunAt)).toBe('2026-05-14T00:00:00.000Z')
  })

  it('keeps the zone a client saved when a server schedules it', async () => {
    const store = await createStore({ storageAuthority: 'runtime' })
    store.addRepo(makeRepo())

    // Created from a New York desktop; 9:00 there, whatever this server's clock says.
    expect(iso(create(store, 'America/New_York').nextRunAt)).toBe('2026-05-13T13:00:00.000Z')
  })

  it.each([
    ['runtime', true],
    ['desktop', false]
  ] as const)(
    'on a %s load, re-seeds next runs an older Orca saved on the host clock: %s',
    async (storageAuthority, reseeded) => {
      const store = await createStore({ storageAuthority })
      store.addRepo(makeRepo())
      const zoned = ['Pacific/Honolulu', 'Pacific/Kiritimati'].map((timezone) =>
        nextAutomationOccurrenceAfter(DAILY_NINE, DTSTART, Date.now(), timezone)
      )
      const created = ['Pacific/Honolulu', 'Pacific/Kiritimati'].map((zone) => create(store, zone))
      store.flush()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store just flushed these automations to this file.
      const persisted = readDataFile() as { automations: Record<string, unknown>[] }
      const hostClock = nextAutomationOccurrenceAfter(DAILY_NINE, DTSTART, Date.now())
      for (const entry of persisted.automations) {
        entry.nextRunAt = hostClock
      }
      writeDataFile(persisted)

      const reloaded = await createStore({ storageAuthority })

      expect(reloaded.listAutomations().map((entry) => entry.nextRunAt)).toEqual(
        reseeded ? zoned : [hostClock, hostClock]
      )
      expect(created.flatMap((entry) => reloaded.listAutomationRuns(entry.id))).toEqual([])
    }
  )
})
