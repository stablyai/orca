/**
 * A move in flight skips each run with a reason that promises a resume; once the WSL host owns the
 * project, the retained local copy goes quiet instead of writing a skip every tick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import type { Automation } from '../../shared/automations-types'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import type { Store } from '../persistence'
import { closeTestStores, createStore, testState } from '../persistence-test-harness'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { AutomationService } from './service'
import { WSL_MOVE_IN_PROGRESS, WSL_MOVE_OWNED_BY_HOST } from './dispatch-refusal'
import type * as PrecheckRunner from './precheck-runner'

const runAutomationPrecheckMock = vi.hoisted(() => vi.fn())

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

vi.mock('./precheck-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof PrecheckRunner>()),
  runAutomationPrecheck: runAutomationPrecheckMock
}))

const makeRepo = (): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1
})

function seedAutomation(store: Store, precheck = false): Automation {
  store.addRepo(makeRepo())
  return store.createAutomation({
    name: 'Nightly check',
    prompt: 'Check the repo',
    ...(precheck ? { precheck: { command: 'true', timeoutSeconds: 30 } } : {}),
    agentId: 'claude',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-12T00:00:00').getTime()
  })
}

function attachedService(store: Store, publish = vi.fn()): AutomationService {
  const service = new AutomationService(store, {
    tickMs: 60_000,
    onAutomationsChanged: publish
  })
  service.setWebContents({ isDestroyed: () => false, send: vi.fn() })
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
  // Re-poked each try: the previous pass may still hold the re-entrancy guard while it flushes.
  await vi.waitFor(() => {
    service.setRendererReady()
    expect(nextRunAt()).toBeGreaterThan(before ?? 0)
  })
}

let fenceDir: string
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-automation-wsl-move-'))
  fenceDir = mkdtempSync(join(tmpdir(), 'orca-automation-wsl-fence-'))
  loadWslMoveFence(fenceDir)
  runAutomationPrecheckMock.mockReset()
  vi.useFakeTimers()
})
afterEach(async () => {
  await closeTestStores()
  vi.useRealTimers()
  resetWslMoveFenceForTests()
  removeTreeSync(testState.dir)
  removeTreeSync(fenceDir)
})

describe('scheduled automations under a WSL move', () => {
  it('skips a run while the move is in flight, promising a resume', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedAutomation(store)
    seedWslMoveCutover(fenceDir, cutover('move-1', 'source-fenced', {}, { repoIds: ['r1'] }))
    const service = attachedService(store)

    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')

    const runs = store.listAutomationRuns(automation.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      status: 'skipped_unavailable',
      error: WSL_MOVE_IN_PROGRESS
    })
    expect(WSL_MOVE_IN_PROGRESS).toBe(
      "This automation's project is moving to its WSL host, so Orca skipped this run. Runs resume when the move finishes."
    )
  })

  it('writes no skip on any tick once the WSL host owns the project', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedAutomation(store)
    seedWslMoveCutover(
      fenceDir,
      cutover('move-1', 'destination-committed', {}, { repoIds: ['r1'] })
    )
    const publish = vi.fn()
    const service = attachedService(store, publish)

    await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')
    await evaluateAt(store, service, automation.id, '2026-05-14T09:01:00')
    await evaluateAt(store, service, automation.id, '2026-05-15T09:01:00')

    expect(store.listAutomationRuns(automation.id)).toEqual([])
    expect(publish).not.toHaveBeenCalled()
    expect(store.listAutomations().find((entry) => entry.id === automation.id)?.nextRunAt).toBe(
      new Date('2026-05-16T09:00:00').getTime()
    )
    expect(WSL_MOVE_OWNED_BY_HOST).toBe(
      "This automation's project now runs on its WSL host, which runs this automation there. Orca no longer runs this local copy."
    )
  })

  it('skips, not fails, a headless run whose move starts during the precheck', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    const automation = seedAutomation(store, true)
    runAutomationPrecheckMock.mockImplementation(async () => {
      seedWslMoveCutover(fenceDir, cutover('move-1', 'source-fenced', {}, { repoIds: ['r1'] }))
      return {
        command: 'true',
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        error: null,
        startedAt: Date.now(),
        completedAt: Date.now()
      }
    })
    const dispatcher = vi.fn()
    const service = new AutomationService(store, {
      tickMs: 60_000,
      headlessDispatcher: dispatcher
    })

    vi.setSystemTime(new Date('2026-05-13T09:01:00'))
    service.start()
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('skipped_unavailable')
    )
    service.stop()

    expect(runAutomationPrecheckMock).toHaveBeenCalledOnce()
    expect(dispatcher).not.toHaveBeenCalled()
    expect(store.listAutomationRuns(automation.id)[0]?.error).toBe(WSL_MOVE_IN_PROGRESS)
  })
})
