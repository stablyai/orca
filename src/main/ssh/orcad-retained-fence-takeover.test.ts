import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import {
  orphanInstallLockCommand,
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand
} from './ssh-relay-install-lock-commands'
import { INSTALL_LOCK_STALE_SECONDS } from './ssh-relay-install-lock'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const host = getRemoteHostPlatform(process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function sh(command: string): Promise<string> {
  const result = await runProcess({ program: '/bin/sh', args: ['-c', command], timeoutMs: 10_000 })
  return result.stdout.trim()
}

// BUG-17: a recovery that took a fence over, failed and retained it left a fresh lock behind, so
// every later recovery read "still fresh" and the host could never be recovered.
describe.skipIf(process.platform === 'win32')('a retained activation fence', () => {
  it('stays fresh to stale takeover until its holder marks it ownerless', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-fence-'))
    roots.push(root)
    const lockDir = join(root, '.install-lock')
    expect(await sh(tryCreateInstallLockCommand(host, lockDir))).toBe('OK')
    const steal = tryStealInstallLockCommand(host, lockDir, INSTALL_LOCK_STALE_SECONDS)

    expect(await sh(steal)).toBe('BUSY')
    await sh(orphanInstallLockCommand(host, lockDir))
    expect(await sh(steal)).toMatch(/OK$/u)
  })
})
