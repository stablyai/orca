import { describe, expect, it, vi } from 'vitest'

const execFileSyncMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: execFileSyncMock
}))

import { killWithDescendantSweep } from '../pty-descendant-termination'

/**
 * Reproduction for issue #9045 — on Windows, deleting a worktree fails with
 * "Failed to physically stop every PTY for worktree" and leaves orphaned
 * claude.exe / node.exe / cmd.exe processes holding handles into the worktree dir.
 *
 * Mechanism (single root cause):
 *   Windows PTY teardown reduces to a ConPTY close of the *direct shell*. The agent's
 *   grandchildren (claude → node/cmd) are never reaped, so they keep the ConPTY conout
 *   pipe open. node-pty's `onExit` — the physical-exit proof the destructive delete gate
 *   (`killAllProcessesForWorktree`, requirePhysicalStop) waits on — only fires once the
 *   conout pipe is free, i.e. once every console-attached descendant is gone. So both
 *   symptoms fall out of one missing tree kill: the gate times out AND the grandchildren
 *   linger as orphans.
 *
 * These tests model that conout dependency at the exact seam that used to be a Windows
 * no-op — `captureDescendantSnapshot` returned null on win32, so `killWithDescendantSweep`
 * never reaped the tree. The fix carries the root PID as a Windows snapshot and reaps the
 * tree with `taskkill /pid <root> /t /f` before the ConPTY close.
 */
describe('repro #9045: Windows agent worktree teardown leaves orphaned process trees', () => {
  /**
   * Models a Windows agent PTY: a shell root whose orphan-prone grandchildren keep the
   * ConPTY conout pipe open. The root's physical exit (node-pty onExit) is proven only if
   * the grandchild tree is already reaped when the ConPTY is closed.
   */
  function simulateWindowsAgentTeardown(config: {
    killWindowsProcessTree?: (rootPid: number) => void
  }): Promise<{ orphans: Set<string>; rootPhysicalExitProven: boolean }> {
    const SHELL_PID = 4321
    const orphans = new Set(['claude.exe', 'node.exe', 'cmd.exe'])
    let rootPhysicalExitProven = false

    const killRoot = (): void => {
      // ConPTY close reaps only the direct shell; onExit fires only when no grandchild
      // is still holding the conout pipe open (the real Windows ConPTY behavior).
      if (orphans.size === 0) {
        rootPhysicalExitProven = true
      }
    }

    return killWithDescendantSweep(SHELL_PID, killRoot, {
      platform: 'win32',
      ...(config.killWindowsProcessTree
        ? { killWindowsProcessTree: config.killWindowsProcessTree }
        : {})
    }).then(() => ({ orphans, rootPhysicalExitProven }))
  }

  it('BUG (pre-fix win32 no-op): grandchildren survive and the physical-stop gate is never satisfied', async () => {
    // Pre-#9045, win32 produced no descendant snapshot, so no tree kill ran — modeled here
    // as a killWindowsProcessTree that does nothing (the old shell-only kill).
    const { orphans, rootPhysicalExitProven } = await simulateWindowsAgentTeardown({
      killWindowsProcessTree: () => {}
    })

    // Both reported symptoms: orphaned claude/node/cmd, and an unproven physical exit that
    // makes `killAllProcessesForWorktree` throw "Failed to physically stop every PTY".
    expect([...orphans]).toEqual(['claude.exe', 'node.exe', 'cmd.exe'])
    expect(rootPhysicalExitProven).toBe(false)
  })

  it('FIX: taskkill /t /f reaps the whole tree, the conout frees, and physical exit is proven', async () => {
    // Exercise the REAL default helper: killWithDescendantSweep → captureDescendantSnapshot
    // (win32) → terminateDescendantSnapshot → killWindowsProcessTree → execFileSync taskkill.
    const orphansRef = { current: new Set<string>() }
    execFileSyncMock.mockReset()
    execFileSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'taskkill' && args.includes('/t') && args.includes('/f')) {
        // taskkill /T /F reaps the shell root and every descendant in one shot.
        orphansRef.current.clear()
      }
      return Buffer.from('')
    })

    const SHELL_PID = 4321
    const orphans = new Set(['claude.exe', 'node.exe', 'cmd.exe'])
    orphansRef.current = orphans
    let rootPhysicalExitProven = false
    const killRoot = (): void => {
      if (orphans.size === 0) {
        rootPhysicalExitProven = true
      }
    }

    await killWithDescendantSweep(SHELL_PID, killRoot, { platform: 'win32' })

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', String(SHELL_PID), '/t', '/f'],
      expect.objectContaining({ windowsHide: true, stdio: 'ignore' })
    )
    expect([...orphans]).toEqual([])
    expect(rootPhysicalExitProven).toBe(true)
  })
})
