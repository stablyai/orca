import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import type { Automation } from '../../shared/automations/automation-definition'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import type { Store } from '../persistence/loading-store/store'
import {
  closeTestStores,
  createStore,
  readPersistedStateJson,
  testState,
  writePersistedStateJson
} from '../persistence/persistence-test-harness'
import { startedAutomationService, tickAt } from './automation-service-tick.test-fixture'
import { runNowSettled } from './automation-run-now-settled.test-fixture'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const makeRepo = (): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1
})

const SETUP_GONE = 'Project is not set up on the selected automation host anymore.'

/** Inject persisted drift because creation derives a valid run context. */
async function seedUnresolvableAutomation(): Promise<{ store: Store; automation: Automation }> {
  const seed = await createStore()
  seed.addRepo(makeRepo())
  const automation = seed.createAutomation({
    name: 'Nightly check',
    prompt: 'Check the repo',
    agentId: 'claude',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-12T00:00:00').getTime()
  })
  seed.flushOrThrow()
  await seed.freezeWritesAsync()
  const file = join(testState.dir, 'orca-data.json')
  const state = JSON.parse(readPersistedStateJson(file))
  state.automations[0].runContext = {
    kind: 'workspace-run',
    projectId: 'project-1',
    hostId: 'local',
    projectHostSetupId: 'missing-setup',
    repoId: 'r1',
    path: '/repo'
  }
  writePersistedStateJson(file, JSON.stringify(state))
  return { store: await createStore(), automation }
}

async function evaluateAt(store: Store, automationId: string, when: string): Promise<void> {
  const nextRunAt = (): number | undefined =>
    store.listAutomations().find((entry) => entry.id === automationId)?.nextRunAt
  const before = nextRunAt()
  await tickAt(when)
  await vi.waitFor(() => expect(nextRunAt()).toBeGreaterThan(before ?? 0))
}

function seedSkip(store: Store, automation: Automation, scheduledFor: number, error: string): void {
  const run = store.createAutomationRun(automation, scheduledFor)
  store.updateAutomationRun({
    runId: run.id,
    status: 'skipped_unavailable',
    workspaceId: null,
    error
  })
}

describe('repeated skipped_unavailable coalescing', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-skip-coalescing-test-'))
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    removeTreeSync(testState.dir)
  })

  it('gives a manual attempt its own answer rather than folding it into a scheduled skip', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const { store, automation } = await seedUnresolvableAutomation()
    const service = startedAutomationService(store)

    await evaluateAt(store, automation.id, '2026-05-13T09:01:00')
    const manual = await runNowSettled(service, store, automation.id)

    expect(manual.status).toBe('skipped_unavailable')
    expect(manual.occurrenceCount).toBeUndefined()
    expect(store.listAutomationRuns(automation.id)).toHaveLength(2)
  })

  it('counts one occurrence once, however many times the scheduler revisits it', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const { store, automation } = await seedUnresolvableAutomation()
    const scheduledFor = Date.now()
    seedSkip(store, automation, scheduledFor, SETUP_GONE)

    expect(
      store.recordRepeatedAutomationSkip(automation.id, SETUP_GONE, scheduledFor)?.occurrenceCount
    ).toBeUndefined()
    const folded = store.recordRepeatedAutomationSkip(
      automation.id,
      SETUP_GONE,
      scheduledFor + 1000
    )
    expect(folded?.occurrenceCount).toBe(2)
    expect(
      store.recordRepeatedAutomationSkip(automation.id, SETUP_GONE, scheduledFor + 1000)
        ?.occurrenceCount
    ).toBe(2)
  })

  it('resumes counting a folded record across a reload', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const { store, automation } = await seedUnresolvableAutomation()
    const scheduledFor = Date.now()
    seedSkip(store, automation, scheduledFor, SETUP_GONE)
    store.recordRepeatedAutomationSkip(automation.id, SETUP_GONE, scheduledFor + 1000)
    store.flushOrThrow()
    await store.freezeWritesAsync()

    const reloaded = await createStore()

    expect(reloaded.listAutomationRuns(automation.id)[0]?.occurrenceCount).toBe(2)
    expect(
      reloaded.recordRepeatedAutomationSkip(automation.id, SETUP_GONE, scheduledFor + 2000)
        ?.occurrenceCount
    ).toBe(3)
  })
})
