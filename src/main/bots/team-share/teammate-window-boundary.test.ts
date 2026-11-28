// A teammate's own workspace beside the owner's open window: its tab acts run headless, as on a
// paired server, and the window guard keeps every relay about it from the owner. Real runtime and store.
import { afterEach, expect, it } from 'vitest'
import { personWorkspaceKey } from '../../../shared/workspace/identity/person-workspace-key'
import { TEAMMATE_HOMES_SESSION_PARTITION as TEAM } from '../../../shared/workspace-session/teammate-homes-session-partition'
import { getDefaultWorkspaceSession } from '../../../shared/orca-profiles/constants'
import { getRuntimeDesktopSurface } from '../../runtime/construction/runtime-desktop-surface'
import { ownerWindowProbe } from './owner-window-probe.test-support'
import { rig, settleTeammateRig, TEAMMATE } from './teammate-tabs.test-support'

afterEach(settleTeammateRig)

const FILE = '/home/notes.md'
const LEAF = '0f8fad5b-d9cb-469f-a165-70867728950e'

const terminalTab = (id: string, worktreeId: string, sortOrder: number) => ({
  id,
  ptyId: null,
  worktreeId,
  title: `Terminal ${sortOrder + 1}`,
  customTitle: null,
  color: null,
  sortOrder,
  createdAt: sortOrder + 1
})

/** The owner's window open on the host, and a teammate's workspace holding two saved terminals. */
async function besideOwnerWindow() {
  const r = await rig({ home: 'other' })
  const K = personWorkspaceKey({ folderWorkspaceId: r.home.slice('folder:'.length), ...TEAMMATE })
  r.profile.setWorkspaceSession(
    {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [K]: [terminalTab('tab-a', K, 0), terminalTab('tab-b', K, 1)] },
      openFilesByWorktree: {
        [K]: [{ filePath: FILE, relativePath: 'notes.md', worktreeId: K, language: 'markdown' }]
      },
      activeTabIdByWorktree: { [K]: 'tab-a' }
    },
    TEAM
  )
  const probe = ownerWindowProbe(r.runtime, r.profile, r.home)
  r.runtime.attachWindow(1)
  r.runtime['graphStatus'] = 'ready'
  const saved = () => r.profile.getWorkspaceSession(TEAM).tabsByWorktree[K] ?? []
  return { r, K, probe, saved, before: await probe.ownerState() }
}

it("pins, colors and renames a teammate's tab in their own workspace, not through the owner's window", async () => {
  const { r, K, probe, saved, before } = await besideOwnerWindow()
  try {
    await r.runtime.setMobileSessionTabProps(`id:${K}`, {
      tabId: 'tab-b',
      color: '#ff0000',
      isPinned: true,
      customTitle: 'Build'
    })

    expect(saved().find((tab) => tab.id === 'tab-b')).toMatchObject({
      color: '#ff0000',
      isPinned: true,
      customTitle: 'Build'
    })
    expect(probe.relays).toEqual([])
    expect(await probe.ownerState()).toBe(before)
  } finally {
    probe.close()
  }
})

it("reorders a teammate's tabs and keeps their workspace through the owner's window graph", async () => {
  const { r, K, probe, saved, before } = await besideOwnerWindow()
  try {
    const listed = await r.runtime.listMobileSessionTabs(`id:${K}`)
    const group = listed.tabGroups?.[0]
    expect(group).toBeDefined()
    await r.runtime.moveMobileSessionTab(`id:${K}`, {
      kind: 'reorder',
      tabId: 'tab-b',
      targetGroupId: group!.id,
      tabOrder: group!.tabOrder.toReversed()
    })
    expect(saved().map((tab) => tab.id)).toEqual(['tab-b', 'tab-a'])
    expect(probe.relays).toEqual([])
    expect(await probe.ownerState()).toBe(before)

    // The owner's window publishes its graph, which never names the teammate's workspace.
    await r.runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    const order = (await r.runtime.listMobileSessionTabs(`id:${K}`)).tabGroups?.[0]?.tabOrder
    expect(order).toEqual(group!.tabOrder.toReversed())
  } finally {
    probe.close()
  }
})

it("refuses a relay to the owner's window that names a teammate's workspace, and forwards the owner's", async () => {
  const { r, K, probe } = await besideOwnerWindow()
  try {
    const notifier = r.runtime['notifier']!
    expect(() => notifier.createTerminal(K, {})).toThrow(/window_relay_refused: createTerminal/)
    expect(() => notifier.renameTerminal('tab-a', 'x')).toThrow(/window_relay_refused/)
    // A fact the window mirrors is dropped, not thrown.
    notifier.workspaceSleepChanged?.({ worktreeId: K, phase: 'started' })
    const desktop = getRuntimeDesktopSurface()
    expect(() =>
      desktop.sendToWindow(1, 'terminal:requestTabMount', { worktreeId: K, tabId: 'tab-a' })
    ).toThrow(/window_relay_refused/)
    expect(probe.relays).toEqual([])

    notifier.createTerminal(r.home, {})
    notifier.renameTerminal('owner-tab', 'x')
    notifier.workspaceSleepChanged?.({ worktreeId: r.home, phase: 'started' })
    desktop.sendToWindow(1, 'terminal:requestTabMount', { worktreeId: r.home, tabId: 'owner-tab' })
    expect(probe.relays.map((relay) => relay.name)).toEqual([
      'createTerminal',
      'renameTerminal',
      'workspaceSleepChanged',
      'sendToWindow:terminal:requestTabMount'
    ])
  } finally {
    probe.close()
  }
})

it("closes a teammate's tab and pane, and activates their file, without telling the owner's window", async () => {
  const { r, K, probe, saved, before } = await besideOwnerWindow()
  try {
    const listed = await r.runtime.listMobileSessionTabs(`id:${K}`)
    const file = listed.tabs.find((tab) => tab.type !== 'terminal')
    expect(file).toBeDefined()
    await r.runtime.activateMobileSessionTab(`id:${K}`, file!.id, undefined, { person: 'owner' })
    await r.runtime['closeTerminalPane'](K, { kind: 'pane', tabId: 'tab-b', leafId: LEAF })
    await r.runtime.closeMobileSessionTab(`id:${K}`, 'tab-a', { reason: 'user', person: 'owner' })

    expect(saved().map((tab) => tab.id)).toEqual(['tab-b'])
    expect(probe.relays).toEqual([])
    expect(await probe.ownerState()).toBe(before)
  } finally {
    probe.close()
  }
})

it("keeps a teammate's live tabs, files included, through the owner's window graph", async () => {
  const { r, K, probe } = await besideOwnerWindow()
  try {
    await r.runtime.listMobileSessionTabs(`id:${K}`)
    const live = r.runtime['mobileSessionTabsByWorktree'].get(K)
    expect(live?.tabs.some((tab) => tab.type !== 'terminal')).toBe(true)

    await r.runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    // Read before anything hydrates it again from the saved partition.
    expect(r.runtime['mobileSessionTabsByWorktree'].get(K)?.tabs).toEqual(live?.tabs)
  } finally {
    probe.close()
  }
})

it("saves a teammate's chat tab in their own workspace beside the owner's window", async () => {
  const { r, K, probe, before } = await besideOwnerWindow()
  try {
    await r.runtime['changeWindowlessChatTabs'](K, [
      { open: { sessionId: 'chat-k', agent: 'claude', tabId: 'agent-session:chat-k' } }
    ])

    const unified = r.profile.getWorkspaceSession(TEAM).unifiedTabs?.[K] ?? []
    expect(unified.some((tab) => tab.contentType === 'agent-session')).toBe(true)
    expect(probe.relays).toEqual([])
    expect(await probe.ownerState()).toBe(before)
  } finally {
    probe.close()
  }
})
