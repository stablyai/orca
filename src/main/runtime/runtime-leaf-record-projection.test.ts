import { describe, expect, it } from 'vitest'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import type { WorkspaceLayoutModel } from '../../shared/workspace-layout/workspace-layout-model'
import { emptyLayoutBeside } from '../../shared/workspace-layout/workspace-layout-model-rules'
import {
  paneTerminalFact,
  projectRuntimeLeafRecords,
  runtimeLeafKey,
  type PaneTitleReset,
  type RuntimeLeafPtyFacts,
  type RuntimeLeafProjection,
  type RuntimeLeafProjectionInput
} from './runtime-leaf-record-projection'
import {
  LEAF_1,
  LEAF_2,
  LEAF_3,
  LIVENESS_VERDICTS,
  LIVENESS_VERDICTS_STEP_3,
  MIRROR_LEAVES_STEP_1,
  MIRROR_LEAVES_STEP_2,
  MIRROR_LEAVES_STEP_3,
  MIRROR_TABS,
  PANE_1_NEUTRAL_TITLE,
  PANE_1_NEUTRAL_TITLE_AT,
  PTY_A_FACTS_STEP_3,
  PTY_FACTS,
  TAB_1_ROOT,
  WORKTREE_ID
} from './runtime-leaf-record-projection.test-fixture'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'

/** The holder's model of the fixture's workspace: tab-bar ids differ from the terminal ids. */
function fixtureModel(leaf2PtyId: string, leaf3PtyId?: string): WorkspaceLayoutModel {
  const terminal = (id: string, entityId: string, defaultTitle: string) => ({
    id,
    entityId,
    createdAt: 1,
    customTitle: null,
    color: null,
    kind: 'terminal' as const,
    terminal: { defaultTitle }
  })
  return {
    hostId: 'local',
    workspaces: {
      [WORKTREE_ID]: {
        worktreeId: WORKTREE_ID,
        groups: [{ id: 'group-1', tabOrder: ['bar-1', 'bar-2'] }],
        tabs: [
          { ...terminal('bar-1', 'tab-1', 'Terminal 1'), panes: { root: TAB_1_ROOT } },
          {
            ...terminal('bar-2', 'tab-2', 'Terminal 2'),
            panes: { root: { type: 'leaf', leafId: LEAF_3 } }
          }
        ],
        leaves: {
          [LEAF_1]: { ptyId: 'pty-a' },
          [LEAF_2]: { ptyId: leaf2PtyId },
          ...(leaf3PtyId ? { [LEAF_3]: { ptyId: leaf3PtyId } } : {})
        }
      }
    },
    records: {},
    legacy: { terminalRowOwners: {} }
  }
}

type FixtureStep = {
  leaf2PtyId: string
  leaf3PtyId?: string
  previous: RuntimeLeafProjection | null
  ptys?: Partial<Record<string, RuntimeLeafPtyFacts>>
  verdicts?: Record<string, PtyLivenessVerdict | null>
  resets?: Record<string, PaneTitleReset>
}

function projectFixture(step: FixtureStep): RuntimeLeafProjection {
  const beside = emptyLayoutBeside()
  beside.desktopView.panes['tab-1'] = { activeLeafId: LEAF_2, expandedLeafId: null }
  beside.facts.terminalRows['tab-1'] = { title: 'build watch' }
  beside.facts.terminalRows['tab-2'] = { title: 'Terminal 2' }
  const ptys = step.ptys ?? PTY_FACTS
  const input: RuntimeLeafProjectionInput = {
    partitions: [{ ...beside, layout: fixtureModel(step.leaf2PtyId, step.leaf3PtyId) }],
    ptysById: new Map(Object.entries(ptys).flatMap(([id, facts]) => (facts ? [[id, facts]] : []))),
    livenessOf: (ptyId) => (step.verdicts ?? LIVENESS_VERDICTS)[ptyId] ?? null,
    paneTitleResets: (paneKey) => step.resets?.[paneKey] ?? null,
    generatedTitlesEnabled: true,
    previous: step.previous
  }
  return projectRuntimeLeafRecords(input)
}

/** Projection differs from mirror in renderer pane ids and evidence-dated titles; overrides name any additional per-leaf differences. */
function asProjected(
  leaves: RuntimeLeafRecord[],
  overrides: Record<string, Partial<RuntimeLeafRecord>> = {}
): Map<string, RuntimeLeafRecord> {
  return new Map(
    leaves.map((leaf) => [
      runtimeLeafKey(leaf.tabId, leaf.leafId),
      {
        ...leaf,
        paneRuntimeId: -1,
        paneTitleUpdatedAt:
          leaf.paneTitle === null
            ? null
            : leaf.paneTitle === leaf.lastOscTitle
              ? leaf.lastOscTitleAt
              : leaf.paneTitleUpdatedAt,
        ...overrides[leaf.leafId]
      }
    ])
  )
}

const STEP_1: FixtureStep = { leaf2PtyId: 'pty-b', previous: null }

describe('projectRuntimeLeafRecords', () => {
  it("matches today's mirror tabs and leaves for the captured graph", () => {
    const projection = projectFixture(STEP_1)

    expect(projection.tabs).toEqual(new Map(MIRROR_TABS.map((tab) => [tab.tabId, tab])))
    expect(projection.leaves).toEqual(asProjected(MIRROR_LEAVES_STEP_1))
    expect([...projection.leavesByPtyId.keys()]).toEqual(['pty-a', 'pty-b'])
    expect(projection.leavesByPtyId.get('pty-b')?.map((leaf) => leaf.leafId)).toEqual([LEAF_2])
  })

  it('counts a pane rebinding in ptyGeneration across projections, as the mirror does', () => {
    const first = projectFixture(STEP_1)
    const second = projectFixture({ leaf2PtyId: 'pty-c', previous: first })

    expect(second.leaves).toEqual(asProjected(MIRROR_LEAVES_STEP_2))
    expect(
      projectFixture({ leaf2PtyId: 'pty-c', previous: second }).leaves.get(
        runtimeLeafKey('tab-1', LEAF_2)
      )
    ).toMatchObject({ ptyGeneration: 1 })
  })

  it("carries the window's neutral title reset, a lost host and an unregistered PTY", () => {
    const second = projectFixture({ leaf2PtyId: 'pty-c', previous: projectFixture(STEP_1) })
    const third = projectFixture({
      leaf2PtyId: 'pty-c',
      leaf3PtyId: 'pty-d',
      previous: second,
      ptys: { ...PTY_FACTS, 'pty-a': PTY_A_FACTS_STEP_3 },
      verdicts: LIVENESS_VERDICTS_STEP_3,
      resets: {
        [`tab-1:${LEAF_1}`]: { title: PANE_1_NEUTRAL_TITLE, at: PANE_1_NEUTRAL_TITLE_AT }
      }
    })

    expect(third.leaves).toEqual(
      asProjected(MIRROR_LEAVES_STEP_3, {
        // The PTY record's OSC stamp; the mirror's leaf took a second one of its own.
        [LEAF_1]: { lastOscTitleAt: PTY_A_FACTS_STEP_3.lastOscTitleAt },
        // No PTY record: the mirror makes one from the window's transport, the holder has none.
        [LEAF_3]: { connected: false, writable: false }
      })
    )
  })

  it('lets a later OSC title replace a neutral reset', () => {
    const leaf = projectFixture({
      ...STEP_1,
      resets: { [`tab-1:${LEAF_1}`]: { title: PANE_1_NEUTRAL_TITLE, at: 0 } }
    }).leaves.get(runtimeLeafKey('tab-1', LEAF_1))

    expect(leaf).toMatchObject({ paneTitle: 'build watch', title: 'build watch' })
  })

  it('projects every terminal tab the model holds, mounted or not', () => {
    const { tabs, leaves } = projectFixture({ ...STEP_1, ptys: {} })

    expect([...tabs.keys()]).toEqual(['tab-1', 'tab-2'])
    expect(leaves.size).toBe(3)
  })

  it('leaves a saved binding with no PTY record unwritable', () => {
    const leaf = projectFixture({ ...STEP_1, ptys: {} }).leaves.get(runtimeLeafKey('tab-1', LEAF_1))

    expect(leaf).toMatchObject({
      ptyId: 'pty-a',
      connected: false,
      writable: false,
      tailBuffer: []
    })
  })

  it('falls back to the first pane when the desktop focused a pane that is gone', () => {
    const beside = emptyLayoutBeside()
    beside.desktopView.panes['tab-1'] = { activeLeafId: 'gone', expandedLeafId: null }
    const projection = projectRuntimeLeafRecords({
      partitions: [{ ...beside, layout: fixtureModel('pty-b') }],
      ptysById: new Map(),
      livenessOf: () => null,
      paneTitleResets: () => null,
      generatedTitlesEnabled: false,
      previous: null
    })

    expect(projection.tabs.get('tab-1')?.activeLeafId).toBe(LEAF_1)
    expect(projection.tabs.get('tab-2')).toMatchObject({ title: 'Terminal 2' })
  })

  it('hands out records a reader cannot write through', () => {
    const leaf = projectFixture(STEP_1).leaves.get(runtimeLeafKey('tab-1', LEAF_1))!

    // @ts-expect-error connection is the PTY record's fact, not the projection's.
    leaf.connected = false
    // @ts-expect-error the OSC title is the title tracker's PTY fact.
    leaf.lastOscTitle = 'x'
  })
})

describe('paneTerminalFact', () => {
  const registry = (facts: Partial<RuntimeLeafPtyFacts> | null, verdict = null) => ({
    ptysById: new Map(facts ? [['pty', { ...PTY_FACTS['pty-a'], ...facts }]] : []),
    livenessOf: () => verdict
  })

  it('reads the host verdict first, then the PTY record', () => {
    expect(paneTerminalFact(null, registry({}))).toBeNull()
    expect(paneTerminalFact('pty', registry(null))).toBeNull()
    expect(paneTerminalFact('pty', registry({}))).toBe('live')
    expect(paneTerminalFact('pty', registry({ connected: false, lastExitCode: 0 }))).toBe('exited')
    expect(
      paneTerminalFact('pty', {
        ...registry({}),
        livenessOf: () => ({ status: 'unverifiable', reason: 'host lost' })
      })
    ).toBe('unverifiable')
  })

  it('never reads a disconnect without an exit as an exit', () => {
    expect(paneTerminalFact('pty', registry({ connected: false, lastExitCode: null }))).toBe(
      'unverifiable'
    )
  })
})
