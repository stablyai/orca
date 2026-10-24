import { describe, expect, it, vi } from 'vitest'
import {
  createWorktreeDefaultTabTerminals,
  provisionWorktreeTerminals
} from './runtime-worktree-terminal-provisioning'
import {
  setupLayoutOwnerRuntime as setup,
  WORKTREE_ID
} from './orca-runtime-layout-owner-start-fixture'
import { committingSpawn } from './bind-first-pane.test-fixture'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

describe('layout-owner build: a worktree’s default tabs start in main', () => {
  it('starts setup with the localized title in a background tab', async () => {
    const { runtime, session } = setup(() => '초기 설정')
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    const result = await provisionWorktreeTerminals(runtime.provisioningHost(), {
      worktreeSelector: `id:${WORKTREE_ID}`,
      worktreeId: WORKTREE_ID,
      worktreePath: '/workspace',
      setup: { runnerScriptPath: '/workspace/setup.sh', envVars: {} },
      setupOnly: true,
      hasStartupTerminal: false,
      setupCommandPlatform: 'posix',
      surfaceOwner: false
    })

    expect(result.setupSpawned).toBe(true)
    expect(createTerminal).toHaveBeenCalledExactlyOnceWith(
      `id:${WORKTREE_ID}`,
      expect.objectContaining({ title: '초기 설정', surfaceOwner: false }),
      undefined
    )
    expect(session().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.customTitle)).toEqual([
      '초기 설정'
    ])
  })

  it('writes the tabs with their titles and colours in main, then starts each in its pane', async () => {
    const { runtime, spawn, renameTerminal, session } = setup()
    let spawned = 0
    spawn.mockImplementation(committingSpawn(runtime, async () => ({ id: `pty-${++spawned}` })))

    const handles = await createWorktreeDefaultTabTerminals(
      runtime.provisioningHost(),
      `id:${WORKTREE_ID}`,
      WORKTREE_ID,
      {
        runCommands: true,
        tabs: [{ title: 'Dev', command: 'pnpm dev', color: '#ff0000' }, { title: 'Logs' }]
      }
    )

    expect(handles).toHaveLength(2)
    const rows = session().tabsByWorktree[WORKTREE_ID]!
    expect(rows.map((row) => [row.customTitle, row.color])).toEqual([
      ['Dev', '#ff0000'],
      ['Logs', null]
    ])
    expect(spawn.mock.calls.map(([args]) => args.tabId)).toEqual(rows.map((row) => row.id))
    expect(session().defaultTerminalTabsAppliedByWorktreeId?.[WORKTREE_ID]).toBe(true)
    // No window round trip writes a default tab's look.
    expect(renameTerminal).not.toHaveBeenCalled()
  })
})
