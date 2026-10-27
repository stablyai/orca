import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { pickStoredFields } from '../../shared/workspace-layout/stored-record-fields'
import { titleAfterConfirmedShell } from '../../shared/terminal-pane-title-reset'
import { OrcaRuntimeService } from './orca-runtime'
import { RUNTIME_LEAF_PTY_FACT_FIELDS } from './runtime-leaf-record-projection'
import {
  LEAF_1,
  LEAF_2,
  LEAF_3,
  LIVENESS_VERDICTS,
  LIVENESS_VERDICTS_STEP_3,
  MIRROR_LEAVES_STEP_3,
  MIRROR_MADE_PTY_D,
  PANE_1_NEUTRAL_TITLE,
  PTY_A_AGENT_TITLE_OUTPUT,
  PTY_A_FACTS_STEP_3,
  PUBLISHED_LEAVES_STEP_3,
  MIRROR_LEAVES_STEP_1,
  MIRROR_LEAVES_STEP_2,
  MIRROR_TABS,
  PTY_A_OUTPUT,
  PTY_FACTS,
  PUBLISHED_LEAVES,
  WORKTREE_ID
} from './runtime-leaf-record-projection.test-fixture'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { RuntimeSyncedTab } from '../../shared/runtime-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'

// Window-owned builds capture the mirror; layout-owner builds use main layout. runtime-leaf-record-projection.test.ts pins both projections to this fixture.

type MirrorMaps = {
  tabs: Map<string, RuntimeSyncedTab>
  leaves: Map<string, RuntimeLeafRecord>
  ptysById: Map<string, RuntimePtyWorktreeRecord>
}

function makeRuntime(): { runtime: OrcaRuntimeService; mirror: () => MirrorMaps } {
  const session = getDefaultWorkspaceSession()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: graph sync and PTY registration read only these store methods.
  const store = {
    getWorkspaceSession: () => session,
    setWorkspaceSession: () => {},
    getRepos: () => [],
    getRepo: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({}),
    getProjects: () => []
  } as never
  const runtime = new OrcaRuntimeService(store)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the mirror's own maps, which are protected on the runtime.
  const mirror = (): MirrorMaps => runtime as unknown as MirrorMaps
  return { runtime, mirror }
}

function ptyFacts(mirror: MirrorMaps): Record<string, unknown> {
  return Object.fromEntries(
    [...mirror.ptysById].map(([ptyId, pty]) => [
      ptyId,
      { connected: pty.connected, ...pickStoredFields(pty, RUNTIME_LEAF_PTY_FACT_FIELDS) }
    ])
  )
}

const itWindowOwned = it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)

describe("today's graph mirror", () => {
  itWindowOwned('holds the captured tabs, leaves and PTY facts at each step', () => {
    const { runtime, mirror } = makeRuntime()
    runtime.attachWindow(1)
    runtime.registerPty('pty-a', WORKTREE_ID, null, { tabId: 'tab-1', leafId: LEAF_1 })
    runtime.registerPty('pty-b', WORKTREE_ID, null, { tabId: 'tab-1', leafId: LEAF_2 })
    runtime.onPtyData('pty-a', PTY_A_OUTPUT, 1000)
    runtime.onPtyData('pty-b', 'done\r\n', 2000)
    runtime.onPtyExit('pty-b', 1)
    runtime.syncWindowGraph(1, { tabs: MIRROR_TABS, leaves: PUBLISHED_LEAVES })

    expect([...mirror().tabs.values()]).toEqual(MIRROR_TABS)
    expect([...mirror().leaves.values()]).toEqual(MIRROR_LEAVES_STEP_1)
    expect(ptyFacts(mirror())).toEqual({
      'pty-a': PTY_FACTS['pty-a'],
      'pty-b': PTY_FACTS['pty-b']
    })

    runtime.registerPty('pty-c', WORKTREE_ID, null, { tabId: 'tab-1', leafId: LEAF_2 })
    runtime.onPtyData('pty-c', 'restarted\r\n', 3000)
    runtime.syncWindowGraph(1, {
      tabs: MIRROR_TABS,
      leaves: PUBLISHED_LEAVES.map((leaf) =>
        leaf.leafId === LEAF_2 ? { ...leaf, ptyId: 'pty-c' } : leaf
      )
    })

    expect([...mirror().leaves.values()]).toEqual(MIRROR_LEAVES_STEP_2)
    expect(ptyFacts(mirror())).toEqual(PTY_FACTS)
    for (const [ptyId, verdict] of Object.entries(LIVENESS_VERDICTS)) {
      expect(runtime.getPtyLivenessVerdict(ptyId)).toEqual(verdict)
    }

    runtime.onPtyData('pty-a', PTY_A_AGENT_TITLE_OUTPUT, 4000)
    runtime.markPtyLivenessUnverifiable('pty-c', 'host lost')
    expect(titleAfterConfirmedShell('\u2733 Claude Code', 'Terminal 1')).toBe(PANE_1_NEUTRAL_TITLE)
    runtime.syncWindowGraph(1, { tabs: MIRROR_TABS, leaves: PUBLISHED_LEAVES_STEP_3 })

    expect([...mirror().leaves.values()]).toEqual(MIRROR_LEAVES_STEP_3)
    expect(ptyFacts(mirror())).toEqual({
      ...PTY_FACTS,
      'pty-a': PTY_A_FACTS_STEP_3,
      'pty-d': MIRROR_MADE_PTY_D
    })
    // The mirror writes the surface it was shown into the PTY record; the projection writes nothing.
    expect(mirror().ptysById.get('pty-d')).toMatchObject({
      tabId: 'tab-2',
      paneKey: `tab-2:${LEAF_3}`
    })
    for (const [ptyId, verdict] of Object.entries(LIVENESS_VERDICTS_STEP_3)) {
      expect(runtime.getPtyLivenessVerdict(ptyId)).toEqual(verdict)
    }
  })
})
