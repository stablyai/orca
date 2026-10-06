import { describe, expect, it, vi } from 'vitest'
import {
  terminateWindowsProcessTree,
  WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS
} from './windows-process-tree-kill'

describe('terminateWindowsProcessTree', () => {
  it('invokes taskkill /T /F with timeout and windowsHide', async () => {
    const execFileImpl = vi.fn(
      (
        _cmd: string,
        _args: readonly string[],
        _options: { timeout?: number; windowsHide?: boolean },
        callback: (error: Error | null) => void
      ) => {
        callback(null)
      }
    )
    await terminateWindowsProcessTree(1234, {
      execFileImpl: execFileImpl as never
    })
    expect(execFileImpl).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '1234', '/T', '/F'],
      {
        timeout: WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS,
        windowsHide: true
      },
      expect.any(Function)
    )
  })

  it('resolves even when taskkill reports failure (already dead)', async () => {
    const execFileImpl = vi.fn(
      (
        _cmd: string,
        _args: readonly string[],
        _options: { timeout?: number; windowsHide?: boolean },
        callback: (error: Error | null) => void
      ) => {
        callback(new Error('not found'))
      }
    )
    await expect(
      terminateWindowsProcessTree(55, { execFileImpl: execFileImpl as never })
    ).resolves.toBeUndefined()
  })

  it('forwards cancellation to execFile and refuses an already-expired request', async () => {
    const controller = new AbortController()
    const execFileImpl = vi.fn((_cmd, _args, options, callback) => {
      expect(options.signal).toBe(controller.signal)
      callback(null)
    })
    await terminateWindowsProcessTree(1234, {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This mock implements the execFile callback overload used by the runner.
      execFileImpl: execFileImpl as never,
      signal: controller.signal
    })
    controller.abort()
    await terminateWindowsProcessTree(1234, {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This mock implements the execFile callback overload used by the runner.
      execFileImpl: execFileImpl as never,
      signal: controller.signal
    })
    expect(execFileImpl).toHaveBeenCalledOnce()
  })

  it('skips taskkill for invalid pids', async () => {
    const execFileImpl = vi.fn()
    await terminateWindowsProcessTree(0, { execFileImpl: execFileImpl as never })
    await terminateWindowsProcessTree(-1, { execFileImpl: execFileImpl as never })
    expect(execFileImpl).not.toHaveBeenCalled()
  })
})
