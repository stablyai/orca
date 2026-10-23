import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { Store } from '../loading-store/store'
import {
  placeUnshownLiveTerminals,
  type LiveTerminalPlacementPorts
} from '../../runtime/terminal/adoption/unshown-live-terminal-placement'
import { WindowSession } from './terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore,
  reopenTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
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

/** Quit and relaunch: what main loads is the profile on disk. */
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

/** Main's startup pass over a real profile, the host census answering with `ptys`. */
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
    // The pane each fake terminal names stands in for the host's answer.
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

  it('a bind by main’s pass raises the pane’s binding generation by exactly one', async () => {
    const store = await openStore((window) => window.addTab(WORKTREE, TAB, LEAF))
    const before = store.getPtyBindingGeneration('local', LEAF) ?? 0

    await placeOn(store, [livePty('pty-agent', { tabId: TAB, paneKey: `${TAB}:${LEAF}` })])

    expect(store.getPtyBindingGeneration('local', LEAF)).toBe(before + 1)
    // A command that changes no binding (a rename) leaves it as it is.
    await store.applyLayoutCommand({
      type: 'renameTab',
      workspace: WORKTREE,
      tabId: TAB,
      kind: 'custom',
      title: 'x'
    })
    expect(store.getPtyBindingGeneration('local', LEAF)).toBe(before + 1)
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
    // A census then names the new pane as the terminal's, so a window reads it as shown.
    expect(placement.recordedPanes.get('pty-cli')).toBe(
      `${adopted?.id}:${Object.keys(bindings?.ptyIdsByLeafId ?? {})[0]}`
    )
    // The next startup finds it shown and places nothing twice.
    expect((await placeOn(relaunched, [livePty('pty-cli')])).placed).toEqual([])
  })

  it('leaves a terminal whose spawn is still binding its pane to that spawn', async () => {
    const store = await openStore((window) => window.addTab(WORKTREE, TAB, LEAF))

    const placement = await placeOn(store, [livePty('pty-starting')], {
      isStillBinding: () => true
    })

    expect(placement).toMatchObject({ placed: [], declined: [] })
    expect(terminalTabs(store)).toHaveLength(1)
  })

  it('leaves alone a terminal a pane shows, one being killed, and a remote one', async () => {
    const store = await openStore((window) => {
      window.addTab(WORKTREE, TAB, LEAF)
      window.bind(TAB, LEAF, 'pty-bound')
    })
    const remote: LivePty = { ...livePty('ssh:host@@pty-remote'), connectionId: 'host' }

    const placement = await placeOn(store, [livePty('pty-bound'), livePty('pty-closing'), remote], {
      refreshInventory: async () => ({
        exitingPtyIds: new Set(['pty-closing']),
        workspaceIds: new Set([WORKTREE])
      })
    })

    expect(placement).toMatchObject({ placed: [], declined: [] })
    expect(terminalTabs(store).map((tab) => tab.id)).toEqual([TAB])
  })

  it('places nothing in a workspace this host does not know (removed outside the app)', async () => {
    const store = await openStore((window) => window.addTab(WORKTREE, TAB, LEAF))
    const stray: LivePty = { ...livePty('pty-stray'), worktreeId: 'repo-local::/fixture/removed' }

    const placement = await placeOn(store, [stray])

    expect(placement).toMatchObject({ placed: [], declined: [] })
    expect(Object.keys(store.getWorkspaceSession().tabsByWorktree)).toEqual([WORKTREE])
  })

  it('a terminal main cannot place is declined, and the rest are still placed', async () => {
    const store = await openStore((window) => window.addTab(WORKTREE, TAB, LEAF))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const apply: LiveTerminalPlacementPorts['apply'] = (command) =>
      command.adopt?.ptyId === 'pty-bad'
        ? Promise.reject(new Error('record unreadable'))
        : store.applyLayoutCommand(command)

    const placement = await placeOn(store, [livePty('pty-bad'), livePty('pty-good')], { apply })

    expect(placement).toMatchObject({ placed: ['pty-good'], declined: ['pty-bad'] })
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0])).toContain('record unreadable')
    warn.mockRestore()
  })

  it('places nothing, and does not fail, when the census itself fails', async () => {
    const store = await openStore((window) => window.addTab(WORKTREE, TAB, LEAF))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const placement = await placeOn(store, [livePty('pty-cli')], {
      refreshInventory: () => Promise.reject(new Error('terminal service down'))
    })

    expect(placement).toMatchObject({ placed: [], declined: [] })
    expect(terminalTabs(store)).toHaveLength(1)
    warn.mockRestore()
  })

  it('places nothing when the host census could not answer', async () => {
    const store = await openStore((window) => window.addTab(WORKTREE, TAB, LEAF))

    const placement = await placeOn(store, [livePty('pty-cli')], {
      refreshInventory: async () => null
    })

    expect(placement).toMatchObject({ placed: [], declined: [] })
    expect(terminalTabs(store)).toHaveLength(1)
  })
})
