/**
 * A target that cannot resolve refuses every occurrence, and the refusal record
 * must stay — a user who sees nothing concludes the feature is broken. What must
 * not stay is one row per occurrence: retention keeps 100 runs per automation, so
 * a five-minute schedule would bury its real history in under a day.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import type { Automation } from '../../shared/automations-types'
import type { Store } from '../persistence'
import { AutomationService } from './service'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const testState = { dir: '' }

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

async function createStore(): Promise<Store> {
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store: StoreClass, initDataPath } = await import('../persistence')
  initDataPath()
  return new StoreClass()
}

const makeRepo = (): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1
})

const SETUP_GONE = 'Project is not set up on the selected automation host anymore.'

const NO_WINDOW = 'No Orca window was available to launch the automation.'

/**
 * Daily at 09:00, pointed at a project host setup that does not exist. The
 * unresolvable context is written into the stored record and reloaded, as drift
 * after creation would leave it — the create path derives contexts itself.
 */
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
  const file = join(testState.dir, 'orca-data.json')
  const state = JSON.parse(readFileSync(file, 'utf-8'))
  state.automations[0].runContext = {
    kind: 'workspace-run',
    projectId: 'project-1',
    hostId: 'local',
    projectHostSetupId: 'missing-setup',
    repoId: 'r1',
    path: '/repo'
  }
  writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8')
  return { store: await createStore(), automation }
}

/** Daily at 09:00 against a repo that resolves, so only the window can refuse it. */
function seedRunnableAutomation(store: Store): Automation {
  store.addRepo(makeRepo())
  return store.createAutomation({
    name: 'Nightly check',
    prompt: 'Check the repo',
    agentId: 'claude',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-12T00:00:00').getTime()
  })
}

function attachedService(store: Store): AutomationService {
  const service = new AutomationService(store, { tickMs: 60_000 })
  service.setWebContents({ isDestroyed: () => false, send: vi.fn() } as never)
  return service
}

/** One scheduler pass. `nextRunAt` advancing is the signal that it finished. */
async function evaluateAt(
  store: Store,
  service: AutomationService,
  automationId: string,
  when: string
): Promise<void> {
  const nextRunAt = (): number | undefined =>
    store.listAutomations().find((entry) => entry.id === automationId)?.nextRunAt
  const before = nextRunAt()
  vi.setSystemTime(new Date(when))
  service.setRendererReady()
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

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('folds every later refusal into the first record instead of writing a row each', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const { store, automation } = await seedUnresolvableAutomation()
    const service = attachedService(store)

    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')
    await evaluateAt(store, service, automation.id, '2026-05-14T09:01:00')
    await evaluateAt(store, service, automation.id, '2026-05-15T09:01:00')

    const runs = store.listAutomationRuns(automation.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      status: 'skipped_unavailable',
      error: SETUP_GONE,
      occurrenceCount: 3,
      // The record keeps the first occurrence and names the latest it stands for.
      scheduledFor: new Date('2026-05-13T09:00:00').getTime(),
      lastOccurrenceAt: new Date('2026-05-15T09:00:00').getTime()
    })
  })

  /**
   * Closing the window on macOS keeps the scheduler running — nothing stops it
   * until quit — so this refusal repeats on the schedule's own cadence and must
   * fold like any other, or a five-minute automation buries its history in ~8h.
   */
  it('folds the refusals a closed window produces instead of writing a row each', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedRunnableAutomation(store)
    const service = attachedService(store)

    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')
    service.setWebContents(null)
    await evaluateAt(store, service, automation.id, '2026-05-14T09:01:00')
    await evaluateAt(store, service, automation.id, '2026-05-15T09:01:00')
    await evaluateAt(store, service, automation.id, '2026-05-16T09:01:00')

    const runs = store.listAutomationRuns(automation.id)
    expect(runs.map((run) => run.status)).toEqual(['skipped_unavailable', 'dispatching'])
    expect(runs[0]).toMatchObject({
      error: NO_WINDOW,
      occurrenceCount: 3,
      lastOccurrenceAt: new Date('2026-05-16T09:00:00').getTime()
    })
  })

  it('starts a new record when a real run intervened, so history is not rewritten', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const { store, automation } = await seedUnresolvableAutomation()
    const completed = store.createAutomationRun(
      automation,
      new Date('2026-05-12T09:00:00').getTime()
    )
    store.updateAutomationRun({ runId: completed.id, status: 'completed', workspaceId: null })
    const service = attachedService(store)

    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')
    await evaluateAt(store, service, automation.id, '2026-05-14T09:01:00')

    const runs = store.listAutomationRuns(automation.id)
    expect(runs.map((run) => run.status)).toEqual(['skipped_unavailable', 'completed'])
    expect(runs[0].occurrenceCount).toBe(2)
  })

  it('gives a manual attempt its own answer rather than folding it into a scheduled skip', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const { store, automation } = await seedUnresolvableAutomation()
    const service = attachedService(store)

    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')
    const manual = await service.runNow(automation.id)

    expect(manual.status).toBe('skipped_unavailable')
    expect(manual.occurrenceCount).toBeUndefined()
    expect(store.listAutomationRuns(automation.id)).toHaveLength(2)
  })

  it('never folds a scheduled refusal into a manual one', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const { store, automation } = await seedUnresolvableAutomation()
    const manual = store.createAutomationRun(automation, Date.now(), 'manual')
    store.updateAutomationRun({
      runId: manual.id,
      status: 'skipped_unavailable',
      workspaceId: null,
      error: SETUP_GONE
    })

    expect(
      store.recordRepeatedAutomationSkip(automation.id, SETUP_GONE, Date.now() + 1000)
    ).toBeNull()
  })

  // Merging these would destroy the signal the record exists to carry.
  it('keeps distinct diagnoses in distinct records', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const { store, automation } = await seedUnresolvableAutomation()
    seedSkip(store, automation, Date.now(), 'The SSH host is unreachable.')

    expect(
      store.recordRepeatedAutomationSkip(automation.id, SETUP_GONE, Date.now() + 1000)
    ).toBeNull()
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

  it('announces the fold, so a client that is not polling still sees the repeat', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const { store, automation } = await seedUnresolvableAutomation()
    const published: unknown[] = []
    const service = new AutomationService(store, {
      tickMs: 60_000,
      onAutomationsChanged: (payload) => published.push(payload)
    })
    service.setWebContents({ isDestroyed: () => false, send: vi.fn() } as never)

    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')
    published.length = 0
    await evaluateAt(store, service, automation.id, '2026-05-14T09:01:00')

    expect(published).toEqual([{ reason: 'run', selector: { kind: 'self' } }])
  })

  // Rollback shape: a build that never heard of these fields writes plain rows and
  // preserves stamped ones, so an upgrade resumes counting instead of restarting.
  it('resumes counting a folded record across a reload', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const { store, automation } = await seedUnresolvableAutomation()
    const scheduledFor = Date.now()
    seedSkip(store, automation, scheduledFor, SETUP_GONE)
    store.recordRepeatedAutomationSkip(automation.id, SETUP_GONE, scheduledFor + 1000)
    store.flush()

    const { Store: StoreClass } = await import('../persistence')
    const reloaded = new StoreClass()

    expect(reloaded.listAutomationRuns(automation.id)[0]?.occurrenceCount).toBe(2)
    expect(
      reloaded.recordRepeatedAutomationSkip(automation.id, SETUP_GONE, scheduledFor + 2000)
        ?.occurrenceCount
    ).toBe(3)
  })
})
