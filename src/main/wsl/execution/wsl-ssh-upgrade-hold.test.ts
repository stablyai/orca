import { once } from 'node:events'
import { spawnProcess } from '@orca/process-host'
import { describe, expect, it } from 'vitest'
import { waitForWslSshUpgradeHold } from './wsl-ssh-upgrade-hold'

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
      expect(hold?.signal.aborted).toBe(false)
    } finally {
      child.kill()
    }
  })

  it('aborts the update signal when the acknowledged process exits before release', async () => {
    const child = startHoldingChild()
    try {
      const hold = await waitForWslSshUpgradeHold(child)
      if (!hold) {
        throw new Error('The child did not acknowledge the hold')
      }
      const aborted = once(hold.signal, 'abort')
      child.stdin.write('exit\n')
      await aborted
      expect(child.exitCode).toBe(23)
      expect(hold.signal.reason.message).toBe(
        'WSL stopped responding during the Orca server update.'
      )
    } finally {
      child.kill()
    }
  })
})
