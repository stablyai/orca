import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { stopBundledRipgrep } from './bundled-ripgrep-stop'

const { signalTree, killChild } = vi.hoisted(() => ({ signalTree: vi.fn(), killChild: vi.fn() }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: signalTree
}))
vi.mock('../../shared/ripgrep-process-availability', () => ({
  killSpawnedRipgrepProcess: killChild
}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('bundled search process termination', () => {
  it('uses the existing bounded tree terminator for Windows WSL and coalesces duplicate stops', async () => {
    const child = spawnProcess({
      program: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)']
    })
    const exited = new Promise((resolve) => child.once('close', resolve))
    try {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      signalTree.mockResolvedValue(true)
      stopBundledRipgrep(child, true)
      stopBundledRipgrep(child, true)
      expect(signalTree).toHaveBeenCalledExactlyOnceWith(child)
      expect(killChild).not.toHaveBeenCalled()
    } finally {
      child.kill()
      await exited
    }
  })
})
