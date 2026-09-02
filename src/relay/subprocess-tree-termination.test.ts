import * as ChildProcessModule from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return { ...actual, execFile: vi.fn() }
})

import { terminateRelaySubprocessTree } from './subprocess-tree-termination'

const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  vi.mocked(ChildProcessModule.execFile).mockReset()
})

describe('terminateRelaySubprocessTree', () => {
  it('invokes Windows taskkill without a shell command', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const child = { pid: 12345, kill: vi.fn() } as unknown as ChildProcessModule.ChildProcess

    terminateRelaySubprocessTree(child)

    expect(ChildProcessModule.execFile).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '12345', '/T', '/F'],
      expect.any(Function)
    )
    expect(child.kill).not.toHaveBeenCalled()
  })
})
