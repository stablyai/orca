import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import type { Automation } from '../../shared/automations-types'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import type { Store } from '../persistence'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { runWslMoveDesktopRewritePass } from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite'
import { resetWslMoveDesktopRewriteStoresForTests } from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite-stores'
import { registerWslMoveMainRewriteStores } from '../persistence/moving-wsl-projects/wsl-move-main-rewrite-stores'
import { registerWslMoveOrchestrationHistoryStore } from '../persistence/moving-wsl-projects/wsl-move-orchestration-history-rewrite'
import { orchestrationDbFile } from '../runtime/orchestration/db/orchestration-db-file'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'
import { OrchestrationDb } from '../runtime/orchestration/db'
import Database from '../sqlite/sync-database'
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
  // Retry while the previous scheduler pass finishes flushing.
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
      error: WSL_MOVE_IN_PROGRESS,
      errorCode: 'wslMoveInProgress'
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

  it('keeps the local copy unchanged through the desktop rewrite, so it neither runs nor loses its next run', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    const store = await createStore()
    const automation = seedAutomation(store)
    seedWslMoveCutover(
      fenceDir,
      cutover('move-1', 'destination-committed', {}, { repoIds: ['r1'] })
    )
    const databasePath = orchestrationDbFile(fenceDir)
    // A dispatch in the moved repo, so the orchestration store has real work to do.
    new OrchestrationDb(databasePath).close()
    const seed = new Database(databasePath)
    seed
      .prepare(`INSERT INTO worker_dispatches (dispatch_id, state, worktree_id) VALUES (?, ?, ?)`)
      .run('d-1', 'succeeded', 'r1::\\\\wsl.localhost\\Ubuntu\\home\\dev\\r1')
    seed.close()
    registerWslMoveMainRewriteStores(store)
    registerWslMoveOrchestrationHistoryStore(databasePath)
    try {
      await runWslMoveDesktopRewritePass({ userDataPath: fenceDir })
      const read = new Database(databasePath)
      expect(read.prepare(`SELECT worktree_id FROM worker_dispatches`).get()).toEqual({
        worktree_id: 'r1::/home/dev/r1'
      })
      read.close()
      expect(store.listAutomations()).toEqual([automation])
      const service = attachedService(store)

      await evaluateAt(store, service, automation.id, '2026-05-13T09:01:00')

      expect(store.listAutomationRuns(automation.id)).toEqual([])
      expect(store.listAutomations()[0]?.nextRunAt).toBe(new Date('2026-05-14T09:00:00').getTime())
    } finally {
      resetWslMoveDesktopRewriteStoresForTests()
      vi.unstubAllEnvs()
    }
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
    expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
      error: WSL_MOVE_IN_PROGRESS,
      errorCode: 'wslMoveInProgress'
    })
  })
})
