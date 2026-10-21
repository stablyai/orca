import { describe, expect, it, vi } from 'vitest'
import { TerminalCreateParams } from '../../../../shared/rpc-contract/terminal-unary-params'
import { setupLayoutOwnerRuntime, WORKTREE_ID } from '../../orca-runtime-layout-owner-start-fixture'

// Why: pinned off, so a run with ORCA_LAYOUT_OWNER=main still checks the switch-off refusal.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

describe("the window's new-tab start with the layout-owner build off", () => {
  it('is refused, starting nothing, so the window starts its tab as today', async () => {
    const { runtime, spawn } = setupLayoutOwnerRuntime()

    await expect(
      runtime.startWindowTabTerminal(WORKTREE_ID, { tabId: 'tab', leafId: 'leaf' }, {})
    ).rejects.toThrow('host_not_owned')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('leaves an older caller’s terminal.create request as it parsed before', () => {
    const older = { worktree: `id:${WORKTREE_ID}`, command: 'ls', tabId: 't', leafId: 'l' }
    expect(TerminalCreateParams.parse(older)).toEqual(older)
    expect(
      TerminalCreateParams.parse({ ...older, windowTab: true, cwd: '/workspace/sub' })
    ).toMatchObject({ windowTab: true, cwd: '/workspace/sub' })
    expect(() => TerminalCreateParams.parse({ ...older, windowTab: false })).toThrow()
  })
})
