import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'
import { _resetTracerForTests, setActiveSink } from '../../observability/tracer'
import type { TerminalPanePlacement } from '../../../shared/terminal-pane-placement'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../../shared/worktree/id'
import { firstLayoutLeafId } from '../restoring-sessions/terminal-layout-normalization'
import { fixture } from './profile-state-delayed-authority-fixture'
import type * as AgreementModule from '../terminal-topology/terminal-pane-placement-agreement'
import type { PersistPtyBindingArgs } from './pty-binding-persistence'

const agreementCheck = vi.hoisted(() => ({ throws: false }))
vi.mock('../terminal-topology/terminal-pane-placement-agreement', async (importOriginal) => {
  const actual = await importOriginal<typeof AgreementModule>()
  return {
    terminalPanePlacementAgreement: (
      ...args: Parameters<typeof actual.terminalPanePlacementAgreement>
    ) => {
      if (agreementCheck.throws) {
        throw new Error('malformed session')
      }
      return actual.terminalPanePlacementAgreement(...args)
    }
  }
})
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const LOCAL_WORKTREE = 'repo-local::/fixture/local'
const REMOTE_WORKTREE = 'repo-remote::/fixture/remote'
const FOLDER_WORKTREE = `${LOCAL_WORKTREE}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}55555555-5555-4555-8555-555555555555`
const SSH_HOST = 'ssh:build-host'
const NOW = 1_800_000_000_000

const NEW_TAB: TerminalPanePlacement = { kind: 'new-tab' }
const ROOT: TerminalPanePlacement = { kind: 'root' }
const split = (parentLeafId: string): TerminalPanePlacement => ({
  kind: 'split',
  parentLeafId,
  direction: 'horizontal'
})

type Scenario = {
  name: string
  hostId?: string
  binding: PersistPtyBindingArgs
  /** Bound once before the measured write, so the measured write finds the leaf present. */
  prebind?: boolean
  /** Each placement gets the existing tab's first leaf, whose id load normalization randomizes. */
  placements: (existingLeaf: string) => [TerminalPanePlacement, string][]
}

const SCENARIOS: Scenario[] = [
  {
    name: 'local fresh tab (mint)',
    binding: {
      worktreeId: LOCAL_WORKTREE,
      tabId: 'tab-new',
      leafId: TEST_LEAF_1,
      ptyId: 'pty-new',
      incarnationId: 'inc-new',
      startupCwd: '/fixture/local/sub',
      hostAdmittedMembership: true
    },
    placements: (leaf) => [
      [NEW_TAB, 'agrees'],
      [ROOT, 'tab_missing'],
      [split(leaf), 'tab_missing']
    ]
  },
  {
    name: 'local existing tab, unknown leaf (graft)',
    binding: {
      worktreeId: LOCAL_WORKTREE,
      tabId: 'tab-local',
      leafId: TEST_LEAF_2,
      ptyId: 'pty-split',
      incarnationId: 'inc-split'
    },
    placements: (leaf) => [
      [split(leaf), 'agrees'],
      [split(TEST_LEAF_1), 'parent_missing'],
      [NEW_TAB, 'tab_exists'],
      [ROOT, 'root_occupied']
    ]
  },
  {
    name: 'local leaf already present (respawn)',
    prebind: true,
    binding: {
      worktreeId: LOCAL_WORKTREE,
      tabId: 'tab-local',
      leafId: TEST_LEAF_2,
      ptyId: 'pty-respawn',
      incarnationId: 'inc-respawn'
    },
    placements: (leaf) => [
      [split(leaf), 'leaf_present'],
      [NEW_TAB, 'leaf_present']
    ]
  },
  {
    name: 'folder workspace fresh tab',
    binding: {
      worktreeId: FOLDER_WORKTREE,
      tabId: 'tab-folder',
      leafId: TEST_LEAF_1,
      ptyId: 'pty-folder',
      hostAdmittedMembership: true
    },
    placements: () => [
      [NEW_TAB, 'agrees'],
      [ROOT, 'tab_missing']
    ]
  },
  {
    name: 'ssh partition fresh tab',
    hostId: SSH_HOST,
    binding: {
      worktreeId: REMOTE_WORKTREE,
      tabId: 'tab-ssh-new',
      leafId: TEST_LEAF_1,
      ptyId: 'pty-ssh-new',
      incarnationId: 'inc-ssh'
    },
    placements: () => [
      [NEW_TAB, 'agrees'],
      [ROOT, 'tab_missing']
    ]
  },
  {
    name: 'ssh partition existing tab (graft)',
    hostId: SSH_HOST,
    binding: {
      worktreeId: REMOTE_WORKTREE,
      tabId: 'tab-remote',
      leafId: TEST_LEAF_2,
      ptyId: 'pty-ssh-split'
    },
    placements: (leaf) => [
      [split(leaf), 'agrees'],
      [NEW_TAB, 'tab_exists']
    ]
  }
]

let placementAttributes: unknown[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  placementAttributes = []
  setActiveSink({
    push: (record) => {
      if (
        typeof record === 'object' &&
        record !== null &&
        'name' in record &&
        record.name === 'persistence.pty-binding' &&
        'attributes' in record &&
        typeof record.attributes === 'object' &&
        record.attributes !== null &&
        'binding.placement' in record.attributes
      ) {
        placementAttributes.push(record.attributes['binding.placement'])
      }
    },
    flush: () => {},
    close: () => {}
  })
})

afterEach(() => {
  agreementCheck.throws = false
  vi.useRealTimers()
  _resetTracerForTests()
})

async function bindAndSave(
  scenario: Scenario,
  placementFor: ((existingLeaf: string) => TerminalPanePlacement) | undefined
): Promise<{ result: boolean; memory: unknown; saved: unknown }> {
  vi.setSystemTime(NOW)
  const { store, readState } = await fixture()
  const existingTab = scenario.hostId ? 'tab-remote' : 'tab-local'
  const existingLeaf = firstLayoutLeafId(
    store.getWorkspaceSession(scenario.hostId).terminalLayoutsByTabId[existingTab]?.root ?? null
  )
  if (!existingLeaf) {
    throw new Error('fixture lost its existing tab')
  }
  const binding = scenario.binding
  const placement = placementFor?.(existingLeaf)
  if (scenario.prebind) {
    await store.persistPtyBinding({ ...binding, ptyId: 'pty-before' }, scenario.hostId)
  }
  placementAttributes = []
  const result = await store.persistPtyBinding(
    placement ? { ...binding, placement } : binding,
    scenario.hostId
  )
  await store.flushPendingOrThrowAsync()
  const state = readState()
  // Load normalization gives each fixture's legacy leaves fresh random ids; compare everything else.
  const stable = (value: unknown): unknown => {
    let text = JSON.stringify(value)
    for (const tabId of ['tab-local', 'tab-remote']) {
      const leaf = firstLayoutLeafId(
        store.getWorkspaceSession(tabId === 'tab-local' ? undefined : SSH_HOST)
          .terminalLayoutsByTabId[tabId]?.root ?? null
      )
      text = leaf ? text.replaceAll(leaf, `<${tabId} leaf>`) : text
    }
    return JSON.parse(text)
  }
  return {
    result,
    memory: stable({
      local: store.getWorkspaceSession(),
      ssh: store.getWorkspaceSession(SSH_HOST)
    }),
    saved: stable({ local: state.workspaceSession, byHost: state.workspaceSessionsByHostId })
  }
}

describe('placement on the binding write is inert', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: memory and saved state match a write without placement`, async () => {
      const baseline = await bindAndSave(scenario, undefined)
      expect(baseline.result).toBe(true)
      expect(placementAttributes).toEqual([scenario.prebind ? 'leaf_present' : 'absent'])
      const cases = scenario.placements('<existing leaf>')
      for (const [index, [, agreement]] of cases.entries()) {
        const placed = await bindAndSave(scenario, (leaf) => scenario.placements(leaf)[index][0])
        expect(placementAttributes).toEqual([agreement])
        expect(placed.result).toBe(baseline.result)
        expect(placed.memory).toEqual(baseline.memory)
        expect(placed.saved).toEqual(baseline.saved)
        expect(JSON.stringify(placed.saved)).not.toContain('placement')
      }
    })
  }

  it('a throwing agreement check leaves the result and state as without placement', async () => {
    const scenario = SCENARIOS[0]
    const baseline = await bindAndSave(scenario, undefined)
    agreementCheck.throws = true
    const placed = await bindAndSave(scenario, () => NEW_TAB)
    expect(placementAttributes).toEqual(['check_threw'])
    expect(placed).toEqual(baseline)
  })

  it('a tombstoned pane is still refused with placement', async () => {
    vi.setSystemTime(NOW)
    const { store } = await fixture()
    const session = store.getWorkspaceSession()
    store.setWorkspaceSession({
      ...session,
      closedTerminalTabTombstonesByTabId: {
        'tab-closed': { closedAt: NOW, worktreeId: LOCAL_WORKTREE }
      }
    })
    const before = structuredClone(store.getWorkspaceSession())
    await expect(
      store.persistPtyBinding({
        worktreeId: LOCAL_WORKTREE,
        tabId: 'tab-closed',
        leafId: TEST_LEAF_1,
        ptyId: 'pty-late',
        placement: NEW_TAB
      })
    ).resolves.toBe(false)
    expect(store.getWorkspaceSession()).toEqual(before)
  })
})
