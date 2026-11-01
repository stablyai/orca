import '../../orca-runtime-test-mocks.spec'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import {
  openTopologyStoreWithAuthority,
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID
} from '../../../persistence/terminal-topology/terminal-topology-profile-fixture'
import { WindowSession } from '../../../persistence/terminal-topology/terminal-topology-window-session-fixture'
import { expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

class MainCrewRuntime extends OrcaRuntimeService {
  seedPty(id: string, handle: string): void {
    this.recordPtyWorktree(id, FIXTURE_GIT_WORKTREE_ID, { connected: true })
    this.terminalIdentity.bindPty(id, handle)
    this.terminalIdentity.setHandle(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: FIXTURE_GIT_WORKTREE_ID,
      tabId: `pty:${id}`,
      leafId: `pty:${id}`,
      ptyId: id,
      ptyGeneration: 0
    })
  }
}

it('retires raw main bindings on real Store-only writes with Crew as sole observer and no installed graph', async () => {
  for (const population of [3, 30]) {
    const directory = mkdtempSync(join(tmpdir(), 'orca-pr34890-main-'))
    const { store, authority } = await openTopologyStoreWithAuthority(
      directory,
      emptyTerminalSessionProfile()
    )
    const db = new OrchestrationDb(':memory:')
    let stop = () => {}
    try {
      const saved = new WindowSession(getDefaultWorkspaceSession())
      for (let i = 0; i < population; i++) {
        const leaf = `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`
        saved.addTab(FIXTURE_GIT_WORKTREE_ID, `tab-main-${i}`, leaf)
        saved.bind(`tab-main-${i}`, leaf, `pty-main-${i}`)
      }
      store.setWorkspaceSession(saved.snapshot(), 'local')
      await store.flushPendingOrThrowAsync()
      const runtime = new MainCrewRuntime(store)
      runtime.setOrchestrationDb(db)
      runtime.seedPty('coord', 'term_coord')
      for (let i = 0; i < population; i++) {
        runtime.seedPty(`pty-main-${i}`, `term_main_${i}`)
      }
      runtime.seedPty('replacement', 'term_replacement')
      const pane = 'tab-main-0:aaaaaaaa-aaaa-4aaa-8aaa-000000000000'
      const run = db.createRun({
        objective: 'Main source',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'coord-pane'
      })
      db.createDispatchContext({
        taskId: db.createTask({ runId: run.id, spec: 'Main worker' }).id,
        assigneeHandle: 'term_missing_stored',
        assigneePaneKey: pane,
        creator: { kind: 'system' },
        maxDepth: 10
      })
      const capture = vi.spyOn(runtime, 'createTerminalIdentityRawInputs')
      const generations = vi.spyOn(store, 'getPtyBindingGeneration')
      stop = runtime.watchOrchestrationCrew(() => {})
      const read = () => runtime.getOrchestrationCrewSnapshot('term_coord').sections.managing[0]
      expect(read().openTarget).toEqual({ kind: 'terminal', handle: 'term_main_0' })
      expect(runtime.getTerminalHandleForPaneKey(pane)).toBe('term_main_0')
      read()
      const initial = capture.mock.calls.length
      const visits = generations.mock.calls.length
      const irrelevant = store.getWorkspaceSession()
      store.setWorkspaceSession({ ...irrelevant, activeTabId: 'tab-main-1' }, 'local')
      await store.flushPendingOrThrowAsync()
      read()
      expect(capture).toHaveBeenCalledTimes(initial)
      expect(generations.mock.calls.length - visits).toBe(population)
      await store.applyLayoutCommand({
        type: 'renameTab',
        workspace: FIXTURE_GIT_WORKTREE_ID,
        tabId: 'tab-main-0',
        kind: 'custom',
        title: 'Named main worker'
      })
      expect(read().label).toBe(
        runtime.orchestrationSenderNames.nameOf(
          { address: 'term_main_0', terminalHandle: 'term_main_0', orcaSessionId: null },
          undefined,
          'Main worker',
          null
        ) ?? 'Main worker'
      )
      expect(capture).toHaveBeenCalledTimes(initial)
      const current = store.getWorkspaceSession()
      const layout = current.terminalLayoutsByTabId['tab-main-0']
      store.setWorkspaceSession(
        {
          ...current,
          terminalLayoutsByTabId: {
            ...current.terminalLayoutsByTabId,
            'tab-main-0': {
              ...layout,
              ptyIdsByLeafId: {
                ...layout.ptyIdsByLeafId,
                'aaaaaaaa-aaaa-4aaa-8aaa-000000000000': 'replacement'
              }
            }
          }
        },
        'local'
      )
      await store.flushPendingOrThrowAsync()
      expect(runtime.getTerminalHandleForPaneKey(pane)).toBe('term_replacement')
      expect(read().openTarget).toEqual({ kind: 'terminal', handle: 'term_replacement' })
      expect(capture.mock.calls.length).toBeGreaterThan(initial)
      const leaf = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000000'
      const beforeGeneration = store.getPtyBindingGeneration('local', leaf) ?? 0
      const beforeCapture = capture.mock.calls.length
      const binding = {
        worktreeId: FIXTURE_GIT_WORKTREE_ID,
        tabId: 'tab-main-0',
        leafId: leaf,
        ptyId: 'replacement',
        correctStartupCwd: '/main-source'
      }
      expect(await store.persistPtyBinding(binding, 'local')).toBe(true)
      expect(store.getPtyBindingGeneration('local', leaf)).toBe(beforeGeneration + 1)
      expect(read().openTarget).toEqual({ kind: 'terminal', handle: 'term_replacement' })
      expect(capture.mock.calls.length).toBeGreaterThan(beforeCapture)
      const stable = capture.mock.calls.length
      authority.failNextWrite()
      await expect(
        store.persistPtyBinding({ ...binding, correctStartupCwd: '/rolled-back' }, 'local')
      ).rejects.toThrow('profile_state_write_failed')
      expect(read().openTarget).toEqual({ kind: 'terminal', handle: 'term_replacement' })
      expect(
        store.getWorkspaceSession().tabsByWorktree[FIXTURE_GIT_WORKTREE_ID][0].startupCwd
      ).toBe('/main-source')
      read()
      expect(capture.mock.calls.length).toBeLessThanOrEqual(stable + 1)
      runtime.seedPty('reentrant', 'term_reentrant')
      const seen: (string | null)[] = []
      const stopReentrant = store.onWorkspaceSessionWritten(() => {
        seen.push(runtime.getTerminalHandleForPaneKey(pane))
        expect(read().openTarget).toEqual({ kind: 'terminal', handle: 'term_reentrant' })
      })
      try {
        const reentrant = structuredClone(store.getWorkspaceSession())
        reentrant.terminalLayoutsByTabId['tab-main-0'].ptyIdsByLeafId = { [leaf]: 'reentrant' }
        store.setWorkspaceSession(reentrant, 'local')
        await store.flushPendingOrThrowAsync()
        expect(seen).toEqual(['term_reentrant'])
      } finally {
        stopReentrant()
      }
      expect(
        runtime.getTerminalHandleForPaneKey('absent:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
      ).toBeNull()
    } finally {
      stop()
      db.close()
      await store.freezeWritesAsync()
      rmSync(directory, { recursive: true, force: true })
    }
  }
})
