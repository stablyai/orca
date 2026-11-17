import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { Store } from '../../../persistence/loading-store/store'
import {
  placeUnshownLiveTerminals,
  type LiveTerminalPlacementPorts
} from './unshown-live-terminal-placement'
import { WindowSession } from '../../../persistence/terminal-topology/testing/terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore,
  reopenTopologyStore
} from '../../../persistence/terminal-topology/testing/terminal-topology-profile-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const WORKTREE = FIXTURE_GIT_WORKTREE_ID
const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const directoryOf = new WeakMap<Store, string>()

async function openStore(seed: (window: WindowSession) => void): Promise<Store> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-unshown-live-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = new WindowSession(getDefaultWorkspaceSession())
  seed(window)
  store.setWorkspaceSession(window.snapshot())
  return restart(store, directory)
}

async function restart(store: Store, directory = directoryOf.get(store)!): Promise<Store> {
  const reopened = await reopenTopologyStore(store, directory)
  directoryOf.set(reopened, directory)
  return reopened
}

type LivePty = Parameters<LiveTerminalPlacementPorts['isStillBinding']>[0]

function livePty(ptyId: string, recorded?: { tabId: string; paneKey: string }): LivePty {
  return {
    ptyId,
    incarnationId: `${ptyId}-inc`,
    worktreeId: WORKTREE,
    connectionId: null,
    runtimeSessionOwned: false,
    connected: true,
    tabId: recorded?.tabId ?? null,
    paneKey: recorded?.paneKey ?? null
  }
}

async function placeOn(
  store: Store,
  ptys: LivePty[],
  overrides: Partial<LiveTerminalPlacementPorts> = {}
) {
  const recordedPanes = new Map<string, string>()
  const placement = await placeUnshownLiveTerminals({
    refreshInventory: async () => ({ workspaceIds: new Set([WORKTREE]) }),
    ptys: () => ptys,
    isStillBinding: () => false,
    paneOf: (pty) => ({
      tabId: pty.tabId ?? null,
      paneKey: pty.paneKey ?? null,
      recordedAtGraphSequence: 0
    }),
    hostIds: () => store.getWorkspaceSessionHostIds(),
    session: (hostId) => store.getWorkspaceSession(hostId),
    apply: (command) => store.applyLayoutCommand(command),
    recordPane: (ptyId, paneKey) => recordedPanes.set(ptyId, paneKey),
    ...overrides
  })
  return { ...placement, recordedPanes }
}

function terminalTabs(store: Store) {
  return store.getWorkspaceSession().tabsByWorktree[WORKTREE] ?? []
}

describe('main shows a live terminal no pane shows, at startup with no window', () => {
  it('binds the pane its record names when that pane lost its binding: one tab, reattachable', async () => {
    const store = await openStore((window) => window.addTab(WORKTREE, TAB, LEAF))

    const placement = await placeOn(store, [
      livePty('pty-agent', { tabId: TAB, paneKey: `${TAB}:${LEAF}` })
    ])

    expect(placement.placed).toEqual(['pty-agent'])
    expect(placement.recordedPanes.get('pty-agent')).toBe(`${TAB}:${LEAF}`)
    expect(terminalTabs(store).map((tab) => tab.id)).toEqual([TAB])
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId).toEqual({
      [LEAF]: 'pty-agent'
    })
  })

  it('shows a terminal no pane ever named in a new tab bound to it, kept across a restart', async () => {
    const store = await openStore((window) => window.addTab(WORKTREE, TAB, LEAF))

    const placement = await placeOn(store, [livePty('pty-cli')])
    const relaunched = await restart(store)

    const tabs = terminalTabs(relaunched)
    expect(tabs).toHaveLength(2)
    const adopted = tabs.find((tab) => tab.id !== TAB)
    const bindings = relaunched.getWorkspaceSession().terminalLayoutsByTabId[adopted?.id ?? '']
    expect(Object.values(bindings?.ptyIdsByLeafId ?? {})).toEqual(['pty-cli'])
    // Publish adopted ownership so subsequent frames show the terminal in its pane.
    expect(placement.recordedPanes.get('pty-cli')).toBe(
      `${adopted?.id}:${Object.keys(bindings?.ptyIdsByLeafId ?? {})[0]}`
    )
    expect((await placeOn(relaunched, [livePty('pty-cli')])).placed).toEqual([])
  })
})
