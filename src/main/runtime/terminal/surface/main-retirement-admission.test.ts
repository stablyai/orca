import '../../orca-runtime-test-mocks.spec'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as paneTree from '../../../../shared/workspace-layout/terminal-pane-tree'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import { mainTerminalSourceInputs } from './pty-pane-query'
import { TerminalSurfaceIndex } from './terminal-surface-index'
import { Store } from '../../../persistence/loading-store/store'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID
} from '../../../persistence/terminal-topology/terminal-topology-profile-fixture'
import {
  addWorkspace,
  emptySession
} from '../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import {
  groupLeaf,
  groupSplit,
  tombstone
} from '../../../../shared/workspace-layout/workspace-layout-retirement.test-fixture'
import {
  loadWorkspaceLayout,
  loadWorkspaceLayoutWithoutReport
} from '../../../../shared/workspace-layout/workspace-layout-load'
import * as retirement from '../../../../shared/workspace-layout/workspace-layout-load-retirement'
import { applyLegacySurfaceTombstones } from '../../../../shared/workspace-layout/workspace-layout-load-bindings'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { workspaceSessionStateSchema } from '../../../../shared/workspace-session-schema'

// The shipped/window authority's parser path is the legacy saved-input admission boundary.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

it('admits P1 through actual serialized parsing, Store identity normalization and getter before the first cold retirement', () => {
  for (const n of [10, 100]) {
    const directory = mkdtempSync(join(tmpdir(), 'orca-pr34890-retirement-admission-'))
    const ids = Array.from(
      { length: n },
      (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`
    )
    const session = addWorkspace(emptySession(), FIXTURE_GIT_WORKTREE_ID, [
      {
        id: 'g1',
        tabs: [{ id: 'target', leaves: ids.map((id, i): [string, string] => [id, `pty-${i}`]) }]
      },
      {
        id: 'g2',
        tabs: [{ id: 'keep', leaves: [['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'keep-pty']] }]
      }
    ])
    session.tabGroupLayouts![FIXTURE_GIT_WORKTREE_ID] = groupSplit(
      groupLeaf('g1'),
      groupSplit(groupLeaf('g1'), groupLeaf('g2'))
    )
    session.terminalSurfaceTombstonesByPaneKey = Object.fromEntries(
      ids.map((id, i) => [
        String(i),
        {
          ...tombstone('target', id, `inc-${i}`),
          worktreeId: FIXTURE_GIT_WORKTREE_ID,
          ptyId: `pty-${i}`
        }
      ])
    )
    session.terminalPtyIncarnationsByPaneKey = Object.fromEntries(
      ids.map((id, i) => [`target:${id}`, `inc-${i}`])
    )
    expect(workspaceSessionStateSchema.parse(session).terminalSurfaceTombstonesByPaneKey).toEqual(
      session.terminalSurfaceTombstonesByPaneKey
    )
    const serializedState = JSON.stringify({
      ...JSON.parse(emptyTerminalSessionProfile()),
      workspaceSession: session
    })
    const store = new Store({ dataFile: join(directory, 'import.json'), serializedState })
    try {
      const saved = store.getWorkspaceSession('local')
      expect(Object.values(saved.terminalSurfaceTombstonesByPaneKey ?? {})).toHaveLength(n)
      expect(saved.tabGroupLayouts?.[FIXTURE_GIT_WORKTREE_ID]).toEqual(
        session.tabGroupLayouts![FIXTURE_GIT_WORKTREE_ID]
      )
      const before = JSON.stringify(saved)
      const candidate = loadWorkspaceLayout('local', saved, nameBasedLoadContext())
      const oracle = vi
        .spyOn(retirement, 'retireLoadedLegacySurfaces')
        .mockImplementation(applyLegacySurfaceTombstones)
      let expected: ReturnType<typeof loadWorkspaceLayout>
      try {
        expected = loadWorkspaceLayout('local', saved, nameBasedLoadContext())
      } finally {
        oracle.mockRestore()
      }
      expect(candidate).toEqual(expected)
      expect(
        candidate.layout.workspaces[FIXTURE_GIT_WORKTREE_ID].tabs.map((tab) => tab.entityId)
      ).toEqual(['keep'])
      expect(candidate.layout.workspaces[FIXTURE_GIT_WORKTREE_ID].groupLayout).toEqual(
        groupSplit(groupLeaf('g1'), groupLeaf('g2'))
      )
      expect(JSON.stringify(store.getWorkspaceSession('local'))).toBe(before)
      console.info('P1 parsed Store getter admission', {
        n,
        tombstones: Object.keys(saved.terminalSurfaceTombstonesByPaneKey!).length,
        surviving: candidate.layout.workspaces[FIXTURE_GIT_WORKTREE_ID].tabs.length
      })
    } finally {
      store.freezeWrites()
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

it('reaches Q0 canonical/unbinding, both fingerprint collections and index spill/projection/selection with complete collection staging', () => {
  const run = (old: boolean) => {
    const events: string[] = []
    const calls: { phase: string; leaves: number }[] = []
    let phase = 'fingerprint'
    const kernel = paneTree.collectLayoutLeafIdsInOrder
    const original = (node: TerminalPaneLayoutNode | null | undefined): string[] =>
      !node
        ? []
        : node.type === 'leaf'
          ? [node.leafId]
          : [...original(node.first), ...original(node.second)]
    const spy = vi.spyOn(paneTree, 'collectLayoutLeafIdsInOrder').mockImplementation((root) => {
      const output = old ? original(root) : kernel(root)
      calls.push({ phase, leaves: output.length })
      events.push(`collect:${output.length}`)
      return output
    })
    try {
      const ids = Array.from(
        { length: 10 },
        (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`
      )
      const saved = addWorkspace(emptySession(), FIXTURE_GIT_WORKTREE_ID, [
        {
          id: 'g1',
          tabs: [{ id: 'target', leaves: ids.map((id, i): [string, string] => [id, `pty-${i}`]) }]
        }
      ])
      const fingerprint = mainTerminalSourceInputs(saved, {
        ...nameBasedLoadContext(),
        ptyGenerationOf: (id) => {
          events.push(`generation:${id}`)
          return 1
        }
      })
      const fingerprintEvents = events.slice()
      phase = 'canonical-unbinding'
      const loaded = loadWorkspaceLayoutWithoutReport('local', saved, nameBasedLoadContext())
      const spilled = structuredClone(saved)
      spilled.tabsByWorktree[FIXTURE_GIT_WORKTREE_ID][0].id = 'spilled'
      spilled.unifiedTabs![FIXTURE_GIT_WORKTREE_ID][0].id = 'spilled'
      spilled.unifiedTabs![FIXTURE_GIT_WORKTREE_ID][0].entityId = 'spilled'
      spilled.tabGroups![FIXTURE_GIT_WORKTREE_ID][0].tabOrder = ['spilled']
      spilled.terminalLayoutsByTabId.spilled = spilled.terminalLayoutsByTabId.target
      delete spilled.terminalLayoutsByTabId.target
      const spill = loadWorkspaceLayoutWithoutReport(
        'runtime:spill',
        spilled,
        nameBasedLoadContext()
      )
      phase = 'index-spill-projection-selection'
      const index = new TerminalSurfaceIndex({
        reads: () => ({
          readPartition: (host) => (host === 'local' ? loaded : spill),
          onLayoutOperationCommitted: () => () => {}
        }),
        hostIds: () => ['local', 'runtime:spill'],
        homeHostId: () => 'local',
        generatedTitlesEnabled: () => false,
        onChanged: () => {}
      })
      const surfaces = index.surfaces()
      expect(surfaces.leaves.map((row) => row.ptyId)).toEqual(ids.map((_, i) => `pty-${i}`))
      expect(fingerprintEvents.slice(0, 2)).toEqual(['collect:10', 'collect:10'])
      expect(fingerprintEvents.slice(2)).toEqual(ids.map((id) => `generation:${id}`))
      expect(calls.filter((call) => call.phase === 'fingerprint')).toHaveLength(2)
      expect(calls.filter((call) => call.phase === 'canonical-unbinding')).toHaveLength(4)
      // Local facts, full spill collection before its early .some match, selection, projection.
      expect(
        calls.filter((call) => call.phase === 'index-spill-projection-selection')
      ).toHaveLength(4)
      return {
        fingerprint,
        loaded,
        surfaces: {
          ...surfaces,
          worktreeIds: [...surfaces.worktreeIds],
          paneFacts: [...surfaces.paneFacts]
        },
        calls
      }
    } finally {
      spy.mockRestore()
    }
  }
  const expected = run(true)
  const actual = run(false)
  expect(actual).toEqual(expected)
  console.info('actual reached collection seams', actual.calls)
})
