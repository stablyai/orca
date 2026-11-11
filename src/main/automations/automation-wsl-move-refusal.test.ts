import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import type { Automation } from '../../shared/automations/automation-definition'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import type { Store } from '../persistence/loading-store/store'
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
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import '../runtime/orchestration/db/contract-constants'
import '../runtime/orchestration/db/messages/mailbox-routing-page'
import '../runtime/orchestration/db/dispatch-row-writer'
import '../runtime/orchestration/db/attempt-outcome-projection'
import Database from '../sqlite/sync-database'
import { AutomationService } from './service'
import { tickAt } from './automation-service-tick.test-fixture'

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
    onAutomationsChanged: publish,
    terminalLauncher: { launch: vi.fn(), available: () => true }
  })
  service.start()
  return service
}

async function evaluateAt(store: Store, automationId: string, when: string): Promise<void> {
  const nextRunAt = (): number | undefined =>
    store.listAutomations().find((entry) => entry.id === automationId)?.nextRunAt
  const before = nextRunAt()
  await tickAt(when)
  await vi.waitFor(() => expect(nextRunAt()).toBeGreaterThan(before ?? 0))
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

      await evaluateAt(store, automation.id, '2026-05-13T09:01:00')
      service.stop()

      expect(store.listAutomationRuns(automation.id)).toEqual([])
      expect(store.listAutomations()[0]?.nextRunAt).toBe(new Date('2026-05-14T09:00:00').getTime())
    } finally {
      resetWslMoveDesktopRewriteStoresForTests()
      vi.unstubAllEnvs()
    }
  })
})
