import '../../orca-runtime-test-mocks.spec'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import {
  openTopologyStoreWithAuthority,
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID
} from '../../../persistence/terminal-topology/terminal-topology-profile-fixture'
import { WindowSession } from '../../../persistence/terminal-topology/terminal-topology-window-session-fixture'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import * as loader from '../../../../shared/workspace-layout/workspace-layout-load'
import * as paneQuery from './pty-pane-query'
import * as surfaceIndex from './terminal-surface-index'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/runtime-types'
import { agentHookServer } from '../../../agent-hooks/server'
import * as providerRebound from '../../../ipc/pty/provider/local-provider-rebound'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
const leaf = (i: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`
const pane = `tab-main-0:${leaf(0)}`

class DefaultPaneRuntime extends OrcaRuntimeService {
  protected override async getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>> {
    const worktree = this.buildResolvedWorktreeFromId(FIXTURE_GIT_WORKTREE_ID)
    return new Map(worktree ? [[worktree.id, worktree]] : [])
  }
  ordinaryFallback = false
  captures = 0
  protected captureTerminalPaneReader(): paneQuery.PtyPaneOf {
    this.captures++
    return this.ordinaryFallback ? (pty) => this.paneOfPty(pty) : super.captureTerminalPaneReader()
  }
  seed(id: string, handle: string, spawnPaneKey?: string, connected = true): void {
    this.recordPtyWorktree(id, FIXTURE_GIT_WORKTREE_ID, { connected, spawnPaneKey })
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
  defaultConsumers(id: string) {
    const pty = this.ptysById.get(id)
    if (!pty) {
      throw new Error('Expected seeded PTY')
    }
    const summary = this.buildPtyTerminalSummary(pty, new Map())
    return {
      summary,
      target: this.orchestrationMailboxDeliveryTarget.resolveTerminal(summary.handle),
      mailbox: this.getOrchestrationMailboxTerminalForHandle(summary.handle),
      close: this.getPtyIdsForExplicitTabClose(FIXTURE_GIT_WORKTREE_ID, 'tab-main-0')
    }
  }
  follow() {
    this.followExportedPaneKeys()
  }
  paneKeyForHandle(handle: string) {
    return this.getPaneKeyForTerminalHandle(handle)
  }
  identityState() {
    return {
      handles: [...this.handles].map(([key, value]) => [key, { ...value, runtimeId: '<runtime>' }]),
      reverse: [...this.handleByPtyId],
      leaves: [...this.leaves],
      incarnations: [...this.handleByPtyIncarnation],
      synthetic: [...this.syntheticTerminalHandles],
      ptys: [...this.ptysById].map(([key, value]) => [key, { ...value }])
    }
  }
}

async function fixture(population: number, ordinary: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-pr34890-finite-'))
  const { store } = await openTopologyStoreWithAuthority(directory, emptyTerminalSessionProfile())
  const db = new OrchestrationDb(':memory:')
  const saved = new WindowSession(getDefaultWorkspaceSession())
  for (let i = 0; i < population; i++) {
    saved.addTab(FIXTURE_GIT_WORKTREE_ID, `tab-main-${i}`, leaf(i))
    saved.bind(`tab-main-${i}`, leaf(i), `pty-main-${i}`)
  }
  store.setWorkspaceSession(saved.snapshot(), 'local')
  await store.flushPendingOrThrowAsync()
  const runtime = new DefaultPaneRuntime(store)
  runtime.ordinaryFallback = ordinary
  runtime.setOrchestrationDb(db)
  runtime.seed('coord', 'term_coord')
  for (let i = 0; i < population; i++) {
    runtime.seed(`pty-main-${i}`, `term_main_${i}`)
  }
  runtime.seed('replacement', 'term_replacement')
  const run = db.createRun({
    objective: 'Finite acquisition',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'coord-pane'
  })
  const task = db.createTask({ runId: run.id, spec: 'Main worker' })
  const dispatch = db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'term_missing_stored',
    assigneePaneKey: pane,
    creator: { kind: 'system' },
    maxDepth: 10
  })
  const stop = runtime.watchOrchestrationCrew(() => {})
  const rebind = async () => {
    const next = structuredClone(store.getWorkspaceSession())
    next.terminalLayoutsByTabId['tab-main-0'].ptyIdsByLeafId = { [leaf(0)]: 'replacement' }
    store.setWorkspaceSession(next, 'local')
    await store.flushPendingOrThrowAsync()
  }
  return {
    runtime,
    session: () => store.getWorkspaceSession(),
    addCloseLeaf: async () => {
      const next = structuredClone(store.getWorkspaceSession())
      const layout = next.terminalLayoutsByTabId['tab-main-0']
      if (!layout.root) {
        throw new Error('Expected seeded layout')
      }
      layout.root = {
        type: 'split',
        direction: 'vertical',
        first: layout.root,
        second: { type: 'leaf', leafId: leaf(98) }
      }
      layout.ptyIdsByLeafId = { ...layout.ptyIdsByLeafId, [leaf(98)]: 'leaf-only' }
      store.setWorkspaceSession(next, 'local')
      await store.flushPendingOrThrowAsync()
    },
    name: async () => {
      const next = structuredClone(store.getWorkspaceSession())
      next.tabsByWorktree[FIXTURE_GIT_WORKTREE_ID][0].customTitle = 'Saved manual name'
      store.setWorkspaceSession(next, 'local')
      await store.flushPendingOrThrowAsync()
    },
    rebind,
    normalize: (value: unknown) =>
      JSON.stringify(value)
        .replaceAll(run.id, '<run>')
        .replaceAll(task.id, '<task>')
        .replaceAll(dispatch.id, '<dispatch>')
        .replaceAll(runtime.getRuntimeId(), '<runtime>'),
    close: async () => {
      stop()
      db.close()
      await store.freezeWritesAsync()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

it('bounds the real public default fallback separately from captured Crew and preserves full outputs and identity effects', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'))
  try {
    for (const population of [3, 30]) {
      const baseline = await fixture(population, true)
      const candidate = await fixture(population, false)
      try {
        const loads = vi.spyOn(loader, 'loadWorkspaceLayoutWithoutReport')
        const capture = vi.spyOn(paneQuery, 'captureMainTerminalPaneLookup')
        const qualify = vi.spyOn(surfaceIndex, 'terminalHoldsPane')
        const measure = (read: () => unknown) => {
          loads.mockClear()
          capture.mockClear()
          qualify.mockClear()
          const value = read()
          return {
            value,
            loads: loads.mock.calls.length,
            surfaceCandidates: capture.mock.calls.reduce(
              (sum, [surfaces]) => sum + surfaces.leaves.length,
              0
            ),
            factCopies: capture.mock.calls.reduce(
              (sum, [surfaces]) => sum + surfaces.paneFacts.size,
              0
            ),
            qualificationCalls: qualify.mock.calls.length
          }
        }
        for (const f of [baseline, candidate]) {
          expect(f.runtime.getTerminalHandleForPaneKey(pane)).toBe('term_main_0')
          f.runtime.getOrchestrationCrewSnapshot('term_coord')
          await f.rebind()
        }
        const old = measure(() => baseline.runtime.getTerminalHandleForPaneKey(pane))
        const next = measure(() => candidate.runtime.getTerminalHandleForPaneKey(pane))
        expect(next.value).toBe(old.value)
        expect(next.value).toBe('term_replacement')
        expect(old.loads).toBe(population + 3)
        expect(next.loads).toBe(2)
        expect(next.surfaceCandidates).toBe(population)
        expect(next.factCopies).toBe(population)
        expect(next.qualificationCalls).toBeLessThanOrEqual(population + 3)
        expect(candidate.runtime.identityState()).toEqual(baseline.runtime.identityState())
        baseline.runtime.ordinaryFallback = false
        const oldCrew = measure(() => baseline.runtime.getOrchestrationCrewSnapshot('term_coord'))
        const nextCrew = measure(() => candidate.runtime.getOrchestrationCrewSnapshot('term_coord'))
        expect(candidate.normalize(nextCrew.value)).toBe(baseline.normalize(oldCrew.value))
        expect(nextCrew.loads).toBe(1)
        expect(nextCrew.surfaceCandidates).toBe(population)
        expect(candidate.runtime.identityState()).toEqual(baseline.runtime.identityState())
        console.log('finite public acquisition receipt', {
          population,
          old,
          next,
          oldCrew,
          nextCrew
        })
        loads.mockRestore()
        capture.mockRestore()
        qualify.mockRestore()
      } finally {
        await candidate.close()
        await baseline.close()
      }
    }
  } finally {
    vi.useRealTimers()
  }
})

it('keeps loaded default title, headless target/refusal, exported hooks and ordered close union at their actual owners', async () => {
  const f = await fixture(3, false)
  const oldPane = `old-tab:${leaf(99)}`
  const transfer = vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
  const returned = vi.spyOn(agentHookServer, 'returnPaneAuthority').mockImplementation(() => {})
  try {
    await f.name()
    f.runtime.seed('pty-main-0', 'term_main_0', oldPane)
    f.runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    const initial = f.runtime.defaultConsumers('pty-main-0')
    expect(initial.summary).toMatchObject({
      title: 'Saved manual name',
      tabId: 'tab-main-0',
      leafId: leaf(0),
      orphaned: false
    })
    expect(initial.target).toEqual(initial.mailbox)
    expect(initial.mailbox).toMatchObject({
      ptyId: 'pty-main-0',
      handle: initial.summary.handle,
      paneKeys: [pane]
    })
    expect(initial.close).toEqual(['pty-main-0'])
    expect(transfer.mock.calls.map(([from, to, id]) => [from, to, id])).toEqual([
      [oldPane, pane, 'pty-main-0']
    ])
    transfer.mockClear()
    f.runtime.follow()
    expect(transfer.mock.calls.map(([from, to, id]) => [from, to, id])).toEqual([
      [oldPane, pane, 'pty-main-0']
    ])
    expect(returned).not.toHaveBeenCalled()
    transfer.mockClear()
    f.runtime.seed('pty-main-1', 'term_main_1', pane)
    f.runtime.follow()
    expect(transfer).not.toHaveBeenCalled()
    expect(returned.mock.calls.map(([key, id]) => [key, id])).toEqual([
      [oldPane, 'pty-main-0'],
      [pane, 'pty-main-1']
    ])
    f.runtime.seed('leaf-only', 'term_leaf_only', undefined, false)
    await f.addCloseLeaf()
    f.runtime.attachWindow(1)
    f.runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-main-0',
          worktreeId: FIXTURE_GIT_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: leaf(0),
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-main-0',
          worktreeId: FIXTURE_GIT_WORKTREE_ID,
          leafId: leaf(0),
          paneRuntimeId: 1,
          ptyId: 'pty-main-0'
        },
        {
          tabId: 'tab-main-0',
          worktreeId: FIXTURE_GIT_WORKTREE_ID,
          leafId: leaf(98),
          paneRuntimeId: 2,
          ptyId: 'leaf-only'
        }
      ]
    })
    const shown = f.runtime.defaultConsumers('pty-main-0')
    expect(shown.target).toMatchObject({
      ptyId: 'pty-main-0',
      handle: shown.summary.handle,
      paneKeys: [pane]
    })
    expect(shown.close).toEqual(['pty-main-0', 'leaf-only'])
    expect(shown.summary.title).toBe('Saved manual name')
  } finally {
    transfer.mockRestore()
    returned.mockRestore()
    await f.close()
  }
})

it('follows an exported key after the real accepted placement has persisted and recorded its pane', async () => {
  const f = await fixture(1, false)
  const exported = `exported:${leaf(97)}`
  const events: string[] = []
  const rebound = vi.spyOn(providerRebound, 'onLocalPtyProviderRebound')
  const transfer = vi
    .spyOn(agentHookServer, 'transferPaneAuthority')
    .mockImplementation((_from, _to, id) => {
      events.push(`follow:${id}`)
    })
  const apply = f.runtime.applyLayoutCommand.bind(f.runtime)
  const applied = vi.spyOn(f.runtime, 'applyLayoutCommand').mockImplementation(async (command) => {
    const reply = await apply(command)
    events.push(`applied:${reply.ok}`)
    return reply
  })
  try {
    f.runtime.seed('restored', 'term_restored', exported)
    f.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'restored',
          cwd: '/fixture/local',
          title: 'shell',
          worktreeId: FIXTURE_GIT_WORKTREE_ID,
          paneKey: exported
        }
      ]
    })
    await expect(f.runtime.placeUnshownLiveTerminals()).resolves.toEqual({
      placed: ['restored'],
      declined: []
    })
    const command = applied.mock.calls[0][0]
    if (command.type !== 'createTerminalTab' || !command.tabId || !command.leafId) {
      throw new Error('Expected the actual restored create command')
    }
    const placedPane = `${command.tabId}:${command.leafId}`
    expect(f.session().terminalLayoutsByTabId[command.tabId].ptyIdsByLeafId?.[command.leafId]).toBe(
      'restored'
    )
    expect(transfer).toHaveBeenCalledWith(exported, placedPane, 'restored', expect.any(Number), {
      authorityVerified: true
    })
    expect(events.indexOf('follow:restored')).toBeGreaterThan(events.indexOf('applied:true'))
    expect(f.runtime.paneKeyForHandle('term_restored')).toBe(placedPane)
  } finally {
    for (const result of rebound.mock.results) {
      if (result.type === 'return') {
        result.value()
      }
    }
    rebound.mockRestore()
    transfer.mockRestore()
    applied.mockRestore()
    await f.close()
  }
})

it('keeps absent and exact/reminted connected public points outside global capture', () => {
  const runtime = new DefaultPaneRuntime(null)
  expect(runtime.getTerminalHandleForPaneKey(pane)).toBeNull()
  expect(runtime.captures).toBe(0)
  runtime.seed('fast', 'term_fast')
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-main-0',
        worktreeId: FIXTURE_GIT_WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: leaf(0),
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-main-0',
        worktreeId: FIXTURE_GIT_WORKTREE_ID,
        leafId: leaf(0),
        ptyId: 'fast',
        paneRuntimeId: 1
      }
    ]
  })
  const before = runtime.captures
  expect(runtime.getTerminalHandleForPaneKey(pane)).toBe('term_fast')
  expect(runtime.getTerminalHandleForPaneKey(`tab-moved:${leaf(0)}`)).toBe('term_fast')
  expect(runtime.captures).toBe(before)
})
