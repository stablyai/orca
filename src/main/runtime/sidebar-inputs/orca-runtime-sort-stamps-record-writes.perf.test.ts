import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../../../shared/constants'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { AgentHookServer } from '../../agent-hooks/server/agent-hook-server'
import {
  closeTestStores,
  createStore,
  makeRepo,
  testState,
  writeDataFile
} from '../../persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../orca-runtime'
import {
  storeFolderWorkspace,
  storeProjectGroup,
  storeWorktreeMeta
} from '../orca-runtime-tests/runtime-store-partial-fixture'
import { requireSwitchedOn } from '../construction/require-sidebar-inputs-enabled'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const OBSERVATION = { isBare: false, isMainWorktree: false, branch: 'before', prunable: false }
const WT = 'r1::/repo/0'
const FOLDER = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-sidebar-record-writes-'))
  vi.useFakeTimers({ now: 80_000, toFake: ['Date'] })
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

async function createHost(population: number) {
  const ids = Array.from({ length: population - 1 }, (_, index) => `r1::/repo/${index}`)
  writeDataFile({
    ...getDefaultPersistedState(testState.dir),
    repos: [makeRepo()],
    worktreeMeta: Object.fromEntries(
      ids.map((id) => [
        id,
        storeWorktreeMeta({
          instanceId: id,
          hostId: 'local',
          gitWorktree: OBSERVATION
        })
      ])
    ),
    projectGroups: [storeProjectGroup({ id: 'group' })],
    folderWorkspaces: [
      storeFolderWorkspace({ id: FOLDER, projectGroupId: 'group', folderPath: '/folder' })
    ]
  })
  const store = createStore()
  const runtime = new OrcaRuntimeService(store)
  const server = new AgentHookServer()
  const pane = (index: number, state: 'working' | 'done'): void => {
    server.ingestTerminalStatus({
      paneKey: `tab-${index}:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      tabId: `tab-${index}`,
      worktreeId: ids[Math.max(0, index - 1)],
      payload: { state, prompt: 'task', agentType: 'codex' }
    })
  }
  for (let index = 0; index < population; index++) {
    pane(index, 'working')
  }
  const detach = runtime.attachAgentStatusStore(server)
  vi.setSystemTime(100_000)
  pane(0, 'done')
  await Promise.resolve()
  await Promise.resolve()
  return { store, runtime, pane, ids, detach }
}

// Count actual yielded panes only while the real reconciliation body runs, without reading its state.
function countReconciliation(runtime: OrcaRuntimeService) {
  const producer = requireSwitchedOn(runtime.sidebarFacts).sortStamps
  const reconcile = producer.noteRecordsWritten
  const values = Map.prototype.values
  let depth = 0
  let paneVisits = 0
  const iterations = vi.spyOn(Map.prototype, 'values').mockImplementation(function* (
    this: Map<unknown, unknown>
  ) {
    for (const value of values.call(this)) {
      if (
        depth > 0 &&
        value &&
        typeof value === 'object' &&
        'worktreeId' in value &&
        'state' in value
      ) {
        paneVisits++
      }
      yield value
    }
    return undefined
  })
  const calls = vi.spyOn(producer, 'noteRecordsWritten').mockImplementation(() => {
    depth++
    try {
      reconcile.call(producer)
    } finally {
      depth--
    }
  })
  return {
    calls,
    paneVisits: () => paneVisits,
    reset: () => {
      calls.mockClear()
      paneVisits = 0
    },
    restore: () => {
      calls.mockRestore()
      iterations.mockRestore()
    }
  }
}

describe('runtime sort-stamp record write admission', () => {
  it.each([100, 1000])(
    'does no observation-only reconciliation or pane visits with %i tracked panes',
    async (population) => {
      const host = await createHost(population)
      const count = countReconciliation(host.runtime)
      let attached = true
      try {
        expect(host.store.getWorktreeMeta(WT)).toMatchObject({
          isUnread: true,
          smartTier: 'done',
          smartAt: 100_000
        })
        host.store.setWorktreeMeta(hostWorktreeTarget({ id: WT, hostId: 'local' }), {
          gitWorktree: { ...OBSERVATION, branch: 'one-changed' }
        })
        await Promise.resolve()
        expect(count.calls).not.toHaveBeenCalled()
        expect(count.paneVisits()).toBe(0)
        for (const id of host.ids) {
          host.store.setWorktreeMeta(hostWorktreeTarget({ id, hostId: 'local' }), {
            gitWorktree: { ...OBSERVATION, branch: 'all-changed' }
          })
        }
        await Promise.resolve()
        expect(count.calls).not.toHaveBeenCalled()
        expect(count.paneVisits()).toBe(0)
        expect(host.store.getWorktreeMeta(WT)?.gitWorktree?.branch).toBe('all-changed')

        host.store.setWorktreeMeta(hostWorktreeTarget({ id: WT, hostId: 'local' }), {
          isUnread: false
        })
        expect(count.calls).not.toHaveBeenCalled()
        await Promise.resolve()
        expect(count.calls).toHaveBeenCalled()
        expect(count.paneVisits()).toBeGreaterThanOrEqual(population)
        expect(host.store.getWorktreeMeta(WT)).toMatchObject({
          isUnread: false,
          smartTier: 'working',
          smartAt: 80_000
        })
        // A reconciliation's own tier write settles once more, then causes no further work.
        await Promise.resolve()
        count.reset()
        await Promise.resolve()
        expect(count.calls).not.toHaveBeenCalled()
        expect(count.paneVisits()).toBe(0)

        host.store.setWorktreeMeta(hostWorktreeTarget({ id: WT, hostId: 'local' }), {
          smartTier: 'done',
          smartAt: 1
        })
        await Promise.resolve()
        expect(host.store.getWorktreeMeta(WT)).toMatchObject({
          smartTier: 'working',
          smartAt: 80_000
        })
        await Promise.resolve()
        vi.setSystemTime(120_000)
        host.pane(0, 'working')
        host.pane(0, 'done')
        expect(host.store.getWorktreeMeta(WT)).toMatchObject({
          isUnread: true,
          smartTier: 'done',
          smartAt: 120_000
        })
        await Promise.resolve()
        await Promise.resolve()
        count.reset()
        host.store.setWorktreeMeta(hostWorktreeTarget({ id: WT, hostId: 'local' }), {
          isUnread: false
        })
        host.detach()
        attached = false
        await Promise.resolve()
        expect(count.calls).not.toHaveBeenCalled()
        expect(count.paneVisits()).toBe(0)
      } finally {
        if (attached) {
          host.detach()
        }
        count.restore()
      }
    }
  )

  it('retains unmatched metadata maintenance, synchronous full and folder saves', async () => {
    const host = await createHost(4)
    const count = countReconciliation(host.runtime)
    try {
      // A canonical-only locator move schedules metadata domains without a per-row setter callback.
      const foreign = hostWorktreeTarget({ id: WT, hostId: 'ssh:server' })
      host.store.setWorktreeMeta(foreign, { displayName: 'Remote original' })
      await Promise.resolve()
      count.reset()
      host.store.migrateWorktreeIdentity(foreign, 'r1::/remote-moved')
      host.store.setWorktreeMeta(hostWorktreeTarget({ id: WT, hostId: 'local' }), {
        gitWorktree: { ...OBSERVATION, branch: 'beside-maintenance' }
      })
      await Promise.resolve()
      expect(count.calls).toHaveBeenCalledOnce()
      expect(
        host.store.getWorktreeMetaForHost('r1::/remote-moved', 'ssh:server')?.displayName
      ).toBe('Remote original')

      count.reset()
      host.store.updateFolderWorkspace(FOLDER, { isUnread: true })
      expect(count.calls).toHaveBeenCalledOnce()
      expect(host.store.getFolderWorkspace(FOLDER)?.isUnread).toBe(true)
      count.reset()
      let synchronousFull = false
      const stop = host.store.onStateWritten((domains) => {
        if (domains === undefined) {
          synchronousFull = count.calls.mock.calls.length > 0
        }
      })
      try {
        const maintenance = await host.store.beginProfileMaintenance()
        await maintenance.resume()
        expect(synchronousFull).toBe(true)
      } finally {
        stop()
      }
    } finally {
      host.detach()
      count.restore()
    }
  })
})
