import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { removeOwnedInstallLockCommand } from './remote-install-lock-owner-commands'
import { getRemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

function lockOwnedBy(token: string): string {
  const home = mkdtempSync(join(tmpdir(), 'orcad-owned-lock-'))
  homes.push(home)
  const lock = join(home, '.install-lock')
  mkdirSync(lock)
  writeFileSync(join(lock, '.orca-fence-owner'), token)
  return lock
}

async function remove(lock: string, token: string): Promise<number | null> {
  const command = removeOwnedInstallLockCommand(getRemoteHostPlatform('linux-x64'), lock, {
    fileName: '.orca-fence-owner',
    token
  })
  return (await runProcess({ program: '/bin/sh', args: ['-c', command] })).code
}

// A cleanup that runs after a takeover must not delete the successor's lock.
describe.skipIf(process.platform === 'win32')('removeOwnedInstallLockCommand', () => {
  it('removes a lock that still names this owner', async () => {
    const lock = lockOwnedBy('t-mine')
    expect(await remove(lock, 't-mine')).toBe(0)
    expect(existsSync(lock)).toBe(false)
  })

  it('leaves a lock a successor took over', async () => {
    const lock = lockOwnedBy('t-successor')
    expect(await remove(lock, 't-mine')).toBe(0)
    expect(existsSync(join(lock, '.orca-fence-owner'))).toBe(true)
  })

  it('succeeds when the lock is already gone', async () => {
    const lock = lockOwnedBy('t-mine')
    rmSync(lock, { recursive: true })
    expect(await remove(lock, 't-mine')).toBe(0)
  })

  // An owner it cannot read may still be its own: failing keeps the caller's token.
  it.skipIf(process.getuid?.() === 0)(
    'fails and keeps a lock whose owner it cannot read',
    async () => {
      const lock = lockOwnedBy('t-mine')
      chmodSync(join(lock, '.orca-fence-owner'), 0)
      try {
        expect(await remove(lock, 't-mine')).not.toBe(0)
        expect(existsSync(lock)).toBe(true)
      } finally {
        chmodSync(join(lock, '.orca-fence-owner'), 0o600)
      }
    }
  )
})

// A path it cannot search hides the owner; that is not proof the lock names no one.
describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'removeOwnedInstallLockCommand on a path it cannot inspect',
  () => {
    it.each([
      ['the lock directory', (lock: string) => lock],
      ['the directory holding the lock', (lock: string) => dirname(lock)]
    ])('fails and keeps the lock when %s is unreadable', async (_label, blocked) => {
      const lock = lockOwnedBy('t-mine')
      chmodSync(blocked(lock), 0)
      try {
        expect(await remove(lock, 't-mine')).not.toBe(0)
      } finally {
        chmodSync(blocked(lock), 0o700)
      }
      expect(existsSync(join(lock, '.orca-fence-owner'))).toBe(true)
    })
  }
)
