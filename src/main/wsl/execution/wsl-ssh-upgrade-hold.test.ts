import { once } from 'node:events'
import { spawnProcess } from '@orca/process-host'
import { describe, expect, it, vi } from 'vitest'
import { isLoopbackSshHost, waitForWslSshUpgradeHold } from './wsl-ssh-upgrade-hold'

function startHoldingChild() {
  return spawnProcess({
    program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
    args: [
      '-e',
      `process.stdout.write('ORCA_WSL_SSH_UPGRADE_READY\\n');
       process.stdin.once('data', () => process.exit(23));`
    ],
    stdio: 'pipe'
  })
}

describe('WSL SSH upgrade hold', () => {
  it('releases the process through stdin EOF without reporting a lost hold', async () => {
    const child = startHoldingChild()
    const closed = once(child, 'close')
    try {
      const hold = await waitForWslSshUpgradeHold(child)
      expect(hold).not.toBeNull()
      expect(child.exitCode).toBeNull()
      hold?.release()
      expect(await closed).toEqual([0, null])
    } finally {
      child.kill()
    }
  })

  it('logs, without failing the update, when the acknowledged process exits before release', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const child = startHoldingChild()
    try {
      const hold = await waitForWslSshUpgradeHold(child)
      expect(hold).not.toBeNull()
      const closed = once(child, 'close')
      child.stdin.write('exit\n')
      expect(await closed).toEqual([23, null])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('exited early'))
      expect(() => hold?.release()).not.toThrow()
    } finally {
      child.kill()
      warn.mockRestore()
    }
  })

  it('treats only loopback hosts as local WSL candidates', () => {
    for (const host of ['localhost', ' LocalHost ', '127.0.0.1', '127.0.1.1', '::1', '[::1]']) {
      expect(isLoopbackSshHost(host)).toBe(true)
    }
    for (const host of ['172.20.0.2', 'wsl', '127.example.com', '10.0.0.1', '']) {
      expect(isLoopbackSshHost(host)).toBe(false)
    }
  })
})
