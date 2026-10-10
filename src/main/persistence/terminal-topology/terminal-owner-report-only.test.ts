import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { _resetTracerForTests, setActiveSink } from '../../observability/tracer'
import { TEST_LEAF_1, TEST_LEAF_2, TEST_LEAF_LIVE } from '../../persistence-session-fixtures'
import { DelayedAuthority } from '../loading-store/profile-state-delayed-authority-fixture'
import { Store } from '../loading-store/store'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import type * as OwnerInvariants from '../../../shared/workspace-layout/terminal-owner-invariants'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

// Off = the binding write as it was before the report-only check.
const check = vi.hoisted(() => ({ enabled: true, throws: false, calls: 0 }))
vi.mock('../../../shared/workspace-layout/terminal-owner-invariants', async (importOriginal) => {
  const actual = await importOriginal<typeof OwnerInvariants>()
  return {
    ...actual,
    findTerminalBindingConflict: (
      ...args: Parameters<typeof actual.findTerminalBindingConflict>
    ) => {
      check.calls += 1
      if (check.throws) {
        throw new Error('malformed session')
      }
      return check.enabled ? actual.findTerminalBindingConflict(...args) : null
    }
  }
})

const LOCAL_WT = 'repo-local::/fixture/local'
const FOLDER_WT = 'repo-local::/fixture/local::workspace:folder-1'
const REMOTE_WT = 'repo-remote::/fixture/remote'
const SSH_HOST = 'ssh:build-host'
const LEAF_MINTED = '55555555-5555-4555-8555-555555555555'
const LEAF_NEW = '66666666-6666-4666-8666-666666666666'
const LEAF_SSH = '88888888-8888-4888-8888-888888888888'
const LEAF_SSH_2 = '99999999-9999-4999-8999-999999999999'
const SSH_PTY = 'ssh:build-host@@relay-1'
const LEAF_MINTED_2 = '77777777-7777-4777-8777-777777777777'

function tab(id: string, worktreeId: string, createdAt: number, ptyId: string): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt
  }
}

function layout(ptyIdsByLeafId: Record<string, string>): TerminalLayoutSnapshot {
  const [first, second] = Object.keys(ptyIdsByLeafId)
  return {
    root: second
      ? {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: first ?? '' },
          second: { type: 'leaf', leafId: second }
        }
      : { type: 'leaf', leafId: first ?? '' },
    activeLeafId: first ?? null,
    expandedLeafId: null,
    ptyIdsByLeafId
  }
}

/** Local holds a saved STA-9417 duplicate (`pty-setup` in two tabs) and a folder-workspace tab. */
function seededProfile(): string {
  const state = buildProfileStateCutoverFixture()
  const local: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [LOCAL_WT]: [
        tab('tab-b', LOCAL_WT, 1, 'pty-primary'),
        tab('tab-minted', LOCAL_WT, 9, 'pty-setup')
      ],
      [FOLDER_WT]: [tab('tab-folder', FOLDER_WT, 2, 'pty-folder')]
    },
    terminalLayoutsByTabId: {
      'tab-b': layout({ [TEST_LEAF_1]: 'pty-primary', [TEST_LEAF_2]: 'pty-setup' }),
      'tab-minted': layout({ [LEAF_MINTED]: 'pty-setup' }),
      'tab-folder': layout({ [TEST_LEAF_LIVE]: 'pty-folder' })
    }
  }
  const ssh: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [REMOTE_WT]: [tab('tab-ssh', REMOTE_WT, 3, SSH_PTY)] },
    terminalLayoutsByTabId: { 'tab-ssh': layout({ [LEAF_SSH]: SSH_PTY }) }
  }
  return JSON.stringify({
    ...state,
    // A fixed install id: load mints a random one when it is missing.
    settings: {
      ...state.settings,
      telemetry: { existedBeforeTelemetryRelease: true, optedIn: null, installId: 'install-1' }
    },
    workspaceSession: local,
    workspaceSessionsByHostId: { [SSH_HOST]: ssh }
  })
}

const SEED = seededProfile()

async function openStore() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-owner-report-'))
  const inner = new ProfileStateSqliteAuthority(join(directory, 'profile-state.db'), 'owner-report')
  inner.writeSerializedState(Buffer.from(SEED))
  const authority = new DelayedAuthority(inner)
  const store = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: authority
  })
  await store.flushPendingOrThrowAsync()
  const close = async (): Promise<void> => {
    await store.freezeWritesAsync()
    rmSync(directory, { recursive: true, force: true })
  }
  return { store, authority, inner, close }
}

type Binding = { worktreeId: string; tabId: string; leafId: string; ptyId: string }

const BINDINGS: [Binding, string?][] = [
  // Clean fresh spawn into a new local tab.
  [{ worktreeId: LOCAL_WT, tabId: 'tab-new', leafId: LEAF_NEW, ptyId: 'pty-new' }],
  // STA-9417 again: the setup PTY bound to a second minted tab.
  [{ worktreeId: LOCAL_WT, tabId: 'tab-minted-2', leafId: LEAF_MINTED_2, ptyId: 'pty-setup' }],
  // STA-9259: a moved leaf rebound under a second tab.
  [{ worktreeId: LOCAL_WT, tabId: 'tab-moved', leafId: TEST_LEAF_2, ptyId: 'pty-moved' }],
  // Folder workspace rebind with a fresh PTY.
  [{ worktreeId: FOLDER_WT, tabId: 'tab-folder', leafId: TEST_LEAF_LIVE, ptyId: 'pty-folder-2' }],
  // Relay reattach writes the ssh: pane into `local` under the same tab:leaf: one surface.
  [{ worktreeId: REMOTE_WT, tabId: 'tab-ssh', leafId: LEAF_SSH, ptyId: SSH_PTY }],
  // A second ssh: leaf on the relay PTY.
  [{ worktreeId: REMOTE_WT, tabId: 'tab-ssh-2', leafId: LEAF_SSH_2, ptyId: SSH_PTY }, SSH_HOST]
]

/** Every write the store makes, as bytes, and the final profile, for one run of the bindings. */
async function runBindings(enabled: boolean) {
  check.enabled = enabled
  const { store, authority, inner, close } = await openStore()
  try {
    const loaded = structuredClone(store.getWorkspaceSession())
    const results: boolean[] = []
    for (const [binding, hostId] of BINDINGS) {
      results.push(await store.persistPtyBinding(binding, hostId))
    }
    await store.flushPendingOrThrowAsync()
    return {
      loaded,
      results,
      writes: authority.captures.flat(),
      saved: inner.readSerializedState()
    }
  } finally {
    await close()
  }
}

describe('report-only terminal owner check', () => {
  const records: { attributes: Record<string, unknown> }[] = []
  afterEach(() => {
    records.length = 0
    check.calls = 0
    check.throws = false
    _resetTracerForTests()
    vi.restoreAllMocks()
  })

  it('writes byte-identical state with and without the check, across local, ssh: and folder sessions', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    setActiveSink({
      push: (record) => {
        const span: (typeof records)[number] = JSON.parse(JSON.stringify(record))
        records.push(span)
      },
      flush: () => {},
      close: () => {}
    })

    const withCheck = await runBindings(true)
    const reported = records
      .filter((record) => record.attributes['binding.owner_conflict'])
      .map((record) => record.attributes['binding.owner_conflict'])
    const withoutCheck = await runBindings(false)

    // Precondition: the check ran and saw every breach the bindings made.
    expect(reported).toEqual([
      'pty_bound_to_other_leaf',
      'leaf_in_other_tab',
      'pty_bound_to_other_leaf'
    ])
    expect(withCheck.results).toEqual([true, true, true, true, true, true])
    expect(withCheck.saved).toContain('tab-minted-2')
    expect(withCheck.writes).toEqual(withoutCheck.writes)
    expect(withCheck.saved).toEqual(withoutCheck.saved)
    // Load leaves saved breaches in place: the duplicate and folder tab load as they were.
    expect(withCheck.loaded.tabsByWorktree).toMatchObject({
      [LOCAL_WT]: [{ id: 'tab-b' }, { id: 'tab-minted' }],
      [FOLDER_WT]: [{ id: 'tab-folder' }]
    })
  })

  it('skips the scan for a rebind the fast lane already admits', async () => {
    check.enabled = true
    const { store, close } = await openStore()
    try {
      const [[binding]] = BINDINGS
      await expect(store.persistPtyBinding(binding)).resolves.toBe(true)
      expect(check.calls).toBe(1)
      await expect(store.persistPtyBinding(binding)).resolves.toBe(true)
      expect(check.calls).toBe(1)
    } finally {
      await close()
    }
  })

  it('writes the binding unchanged when the check throws', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    setActiveSink({
      push: (record) => {
        const span: (typeof records)[number] = JSON.parse(JSON.stringify(record))
        records.push(span)
      },
      flush: () => {},
      close: () => {}
    })
    check.throws = true
    const throwing = await runBindings(true)
    expect(records.map((record) => record.attributes['binding.owner_conflict'])).toContain(
      'check_threw'
    )
    check.throws = false
    const withoutCheck = await runBindings(false)
    expect(throwing.results).toEqual(withoutCheck.results)
    expect(throwing.writes).toEqual(withoutCheck.writes)
    expect(throwing.saved).toEqual(withoutCheck.saved)
  })
})
