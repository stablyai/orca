import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { PtyProcessInfo } from '../providers/pty-provider-contract'
import { setupLayoutOwnerRuntime, WORKTREE_ID } from './orca-runtime-layout-owner-start-fixture'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// A paired desktop's terminal.create resends its pane's own tab and leaf ids on every retry
// (remote-runtime-pty-transport.ts), so main's record of the closed tab refuses a late replay.
function pairedDesktopCreate() {
  const fixture = setupLayoutOwnerRuntime()
  const live: PtyProcessInfo[] = []
  fixture.runtime.setPtyController({
    spawn: fixture.spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () => live)
  })
  const pane = { tabId: randomUUID(), leafId: randomUUID() }
  const create = (reconcileExisting: boolean) =>
    fixture.runtime.dedupeTerminalCreate(
      'paired-desktop',
      `id:${WORKTREE_ID}`,
      'mutation-x',
      reconcileExisting,
      (selector, preAllocatedHandle) =>
        fixture.runtime.createTerminal(selector, {
          ...pane,
          ...(preAllocatedHandle ? { preAllocatedHandle } : {})
        })
    )
  return { ...fixture, live, pane, create }
}

describe('a paired desktop terminal.create replayed with its pane ids', () => {
  it('is refused after another client closed its tab: nothing starts and no tab comes back', async () => {
    const { runtime, spawn, session, pane, create } = pairedDesktopCreate()

    await create(false)
    expect(session().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([pane.tabId])
    expect(spawn).toHaveBeenCalledTimes(1)

    await runtime.applyLayoutCommand({
      type: 'closeTabs',
      workspace: WORKTREE_ID,
      tabIds: [pane.tabId],
      recordClose: 'user'
    })
    expect(session().tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])

    await expect(create(true)).rejects.toThrow('tab_closed')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(session().tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
  })

  it('returns the same tab and terminal for a retry before any close', async () => {
    const { spawn, session, live, pane, create } = pairedDesktopCreate()

    const first = await create(false)
    expect(first.ptyId).toEqual(expect.any(String))
    live.push({
      id: first.ptyId!,
      terminalHandle: first.handle,
      worktreeId: WORKTREE_ID,
      cwd: '/workspace',
      title: ''
    })
    const retry = await create(true)

    expect(retry.handle).toBe(first.handle)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(session().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([pane.tabId])
  })
})
