import { describe, expect, it, vi } from 'vitest'
import { collectLeafIds } from '../../shared/terminal-pane-layout-tree'
import { NEWER_DAEMON_HOLD_ERROR } from '../../shared/newer-daemon-hold'
import { setupLayoutOwnerRuntime, WORKTREE_ID } from './orca-runtime-layout-owner-start-fixture'
import { committingSpawn } from './bind-first-pane.test-fixture'
import { PaneOwnerContentionError } from '../ipc/pty/pane/pane-spawn-operation'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

describe('layout-owner build: a start main could not make keeps its pane, showing why', () => {
  it('writes the pane and shows the failure when the start failed before its pane was written', async () => {
    const { runtime, spawn, session } = setupLayoutOwnerRuntime()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      runtime.createTerminal(`id:${WORKTREE_ID}`, {
        title: 'Setup',
        keepPaneOnStartFailure: true,
        startFailure: new Error('agent runtime needs repair')
      })
    ).rejects.toThrow('agent runtime needs repair')

    expect(spawn).not.toHaveBeenCalled()
    const [row] = session().tabsByWorktree[WORKTREE_ID] ?? []
    expect(row?.customTitle).toBe('Setup')
    const [leafId] = collectLeafIds(session().terminalLayoutsByTabId[row!.id]?.root)
    expect(runtime.startStatusOf(`${row!.id}:${leafId}`)).toEqual({
      status: 'failed',
      reason: 'agent runtime needs repair'
    })
  })

  it('keeps the pane it wrote when the terminal itself fails to start', async () => {
    const { runtime, spawn, session } = setupLayoutOwnerRuntime()
    spawn.mockRejectedValueOnce(new Error('shell not found'))

    await expect(
      runtime.createTerminal(`id:${WORKTREE_ID}`, { keepPaneOnStartFailure: true })
    ).rejects.toThrow('shell not found')

    const [row] = session().tabsByWorktree[WORKTREE_ID] ?? []
    expect(row).toBeDefined()
    const { tabId, leafId } = spawn.mock.calls[0]![0]
    expect(row!.id).toBe(tabId)
    expect(runtime.startStatusOf(`${tabId}:${leafId}`)).toEqual({
      status: 'failed',
      reason: 'shell not found'
    })
  })

  it("shows the pane held, not failed, when a newer build's terminal service may still run it", async () => {
    const { runtime, spawn } = setupLayoutOwnerRuntime()
    spawn.mockRejectedValueOnce(new Error(NEWER_DAEMON_HOLD_ERROR))

    await expect(
      runtime.createTerminal(`id:${WORKTREE_ID}`, { keepPaneOnStartFailure: true })
    ).rejects.toThrow(NEWER_DAEMON_HOLD_ERROR)

    const { tabId, leafId } = spawn.mock.calls[0]![0]
    expect(runtime.startStatusOf(`${tabId}:${leafId}`)).toEqual({
      status: 'held',
      reason: NEWER_DAEMON_HOLD_ERROR
    })
  })

  it('shows no failure when another owner won the pane, whose terminal the window attaches to', async () => {
    const { runtime, spawn } = setupLayoutOwnerRuntime()
    spawn.mockRejectedValueOnce(new PaneOwnerContentionError())

    await expect(
      runtime.createTerminal(`id:${WORKTREE_ID}`, { keepPaneOnStartFailure: true })
    ).rejects.toThrow('terminal_pane_owner_changed')

    const { tabId, leafId } = spawn.mock.calls[0]![0]
    expect(runtime.startStatusOf(`${tabId}:${leafId}`)).toBeNull()
  })

  it('still takes back the pane of a start that did not ask to keep it', async () => {
    const { runtime, spawn, session } = setupLayoutOwnerRuntime()
    spawn.mockRejectedValueOnce(new Error('shell not found'))

    await expect(runtime.createTerminal(`id:${WORKTREE_ID}`)).rejects.toThrow('shell not found')

    expect(session().tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
  })

  it('does not bring back a pane the user closed while its start was failing', async () => {
    const { runtime, spawn, session } = setupLayoutOwnerRuntime()
    spawn.mockImplementationOnce(async ({ tabId }) => {
      await runtime.applyLayoutCommand({
        type: 'closeTabs',
        workspace: WORKTREE_ID,
        tabIds: [tabId!],
        recordClose: 'user'
      })
      throw new Error('shell not found')
    })

    await expect(
      runtime.createTerminal(`id:${WORKTREE_ID}`, { keepPaneOnStartFailure: true })
    ).rejects.toThrow('shell not found')

    expect(session().tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
  })

  it('shows every pane main starts as starting from before the pane is written, then clears it', async () => {
    const { runtime, spawn, session } = setupLayoutOwnerRuntime()
    const seen: unknown[] = []
    spawn.mockImplementationOnce(
      committingSpawn(runtime, async ({ tabId, leafId }) => {
        // The pane is written by now: no frame shows it unbound without a status.
        expect(session().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([tabId])
        seen.push(runtime.startStatusOf(`${tabId}:${leafId}`))
        return { id: 'pty-1' }
      })
    )

    await runtime.createTerminal(`id:${WORKTREE_ID}`)

    expect(seen).toEqual([{ status: 'starting' }])
    const { tabId, leafId } = spawn.mock.calls[0]![0]
    expect(runtime.startStatusOf(`${tabId}:${leafId}`)).toBeNull()
  })

  it('clears the status of a start whose pane it took back', async () => {
    const { runtime, spawn } = setupLayoutOwnerRuntime()
    spawn.mockRejectedValueOnce(new Error('shell not found'))

    await expect(runtime.createTerminal(`id:${WORKTREE_ID}`)).rejects.toThrow('shell not found')

    const { tabId, leafId } = spawn.mock.calls[0]![0]
    expect(runtime.startStatusOf(`${tabId}:${leafId}`)).toBeNull()
  })
})
