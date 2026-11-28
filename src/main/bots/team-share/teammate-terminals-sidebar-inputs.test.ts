// The build where main feeds the owner's sidebar (`ORCA_SIDEBAR_INPUTS=main`): a teammate's own
// terminal in a shared agent's Home never reaches the owner's sidebar inputs, while the owner's do.
import { afterEach, expect, it, vi } from 'vitest'

vi.hoisted(() => Reflect.set(globalThis, 'ORCA_SIDEBAR_INPUTS', 'main'))
import { chatTabCommandsSettled } from '../../runtime/terminal/layout/session-layout-apply.test-fixture'
import { requireSwitchedOn } from '../../runtime/construction/require-sidebar-inputs-enabled'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { rig, settleTeammateRig } from './teammate-tabs.test-support'
import { openTerminal } from './teammate-terminals.test-support'
import { bothTerminals, hookStatusStore, type Rig } from './teammate-terminals.test-support'

afterEach(settleTeammateRig)

const paneOf = (terminalTabId: string) => {
  const [tabId, leafId] = terminalTabId.split('::')
  return makePaneKey(tabId!, leafId!)
}

const homeRecord = (r: Rig) => r.profile.getFolderWorkspace(r.home.slice('folder:'.length))

it('keeps a teammate’s own terminal off the owner’s terminal use and activity facts', async () => {
  const r = await rig()
  const facts = requireSwitchedOn(r.runtime.sidebarFacts)
  const { owners, mates } = await bothTerminals(r)
  const hooks = hookStatusStore(r)
  const activity = () => {
    facts.workspaceActivityFacts.refreshWorkspace(r.workspace)
    return facts.workspaceActivityFacts.snapshot().facts[r.workspace]
  }
  try {
    // Opening or typing in their terminal is not the owner's use of the Home.
    const before = homeRecord(r)?.lastTerminalUseAt
    facts.terminalUse.noteTerminalUse(mates.ptyId, Date.now() + 60_000)
    expect(homeRecord(r)?.lastTerminalUseAt).toBe(before)
    facts.terminalUse.noteTerminalUse(owners.ptyId, Date.now() + 120_000)
    expect(homeRecord(r)?.lastTerminalUseAt).not.toBe(before)

    // An agent at work in their terminal is not the owner's row's.
    hooks.report({ paneKey: paneOf(mates.id), worktreeId: r.workspace, state: 'working' })
    expect(activity()?.agent ?? null).toBe(null)
    hooks.report({ paneKey: paneOf(owners.id), worktreeId: r.workspace, state: 'working' })
    expect(activity()?.agent).not.toBe(null)

    // Their live terminal alone leaves the owner's row with none.
    await r.runtime.onPtyExit(owners.ptyId, 0)
    await chatTabCommandsSettled()
    expect(r.runtime['ptysById'].get(mates.ptyId)?.connected).toBe(true)
    expect(activity()?.terminal ?? null).toBe(null)
  } finally {
    hooks.detach()
  }
})

it('never shows a teammate’s sleep of their own terminals on the owner’s row', async () => {
  const r = await rig()
  const { owners, mates } = await bothTerminals(r)
  const queue = r.runtime.workspaceLifecycle!
  // What the sidebar shows while each one's stop is under way.
  const hintsWhileStopping: string[][] = []
  r.runtime['ptyController'] = {
    ...r.runtime['ptyController']!,
    listProcesses: async () =>
      [...r.runtime['ptysById'].values()]
        .filter((pty) => pty.connected)
        .map((pty) => ({ id: pty.ptyId, cwd: '', title: '' })),
    stopAndWait: async (ptyId) => {
      hintsWhileStopping.push(Object.keys(queue.hints()))
      await r.runtime.onPtyExit(ptyId, 0)
      return true
    },
    kill: (ptyId) => {
      hintsWhileStopping.push(Object.keys(queue.hints()))
      void r.runtime.onPtyExit(ptyId, 0)
      return true
    }
  }
  const worktree = `id:${r.workspace}`
  const ownersRow = `local|${r.workspace}`
  await r.call('mate-desk', 'terminal.sleep', { worktree })
  expect(hintsWhileStopping).not.toEqual([])
  expect(hintsWhileStopping.flat()).not.toContain(ownersRow)
  expect(r.runtime['ptysById'].get(mates.ptyId)?.connected).toBe(false)

  // Nor their closing of all of them.
  const again = await openTerminal(r, 'mate-desk')
  await chatTabCommandsSettled()
  hintsWhileStopping.length = 0
  await r.call('mate-desk', 'terminal.closeAll', { worktree })
  expect(r.runtime['ptysById'].get(again.ptyId)?.connected).toBe(false)
  expect(hintsWhileStopping).not.toEqual([])
  expect(hintsWhileStopping.flat()).not.toContain(ownersRow)

  hintsWhileStopping.length = 0
  await r.call('owner-desk', 'terminal.sleep', { worktree })
  expect(r.runtime['ptysById'].get(owners.ptyId)?.connected).toBe(false)
  expect(hintsWhileStopping.flat()).toContain(ownersRow)
})

it('lets a restart settle the owner’s working row that only a teammate’s live terminal is left in', async () => {
  const r = await rig()
  const { owners, mates } = await bothTerminals(r)
  const folderId = r.home.slice('folder:'.length)
  r.profile.updateFolderWorkspace(folderId, { smartTier: 'working' })
  await r.runtime.onPtyExit(owners.ptyId, 0)
  await chatTabCommandsSettled()
  const live = (ptyId: string) => r.runtime['ptysById'].get(ptyId)?.connected === true
  expect(live(mates.ptyId)).toBe(true)
  await requireSwitchedOn(r.runtime.sidebarFacts).reconcileSortStampTiers({
    probePtyLiveness: async (ptyId) => live(ptyId)
  })
  expect(homeRecord(r)?.smartTier).toBe(undefined)
})
