import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { tryStealInstallLockCommand } from './ssh-relay-install-lock-commands'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'
import { getRemoteHostPlatform, type RemoteHostPlatform } from './ssh-remote-platform'

const OWNER = '.orca-fence-owner'
const successor = { fileName: OWNER, token: 't-relaunch' }
const exitedOwner = { fileName: OWNER, token: 't-exited', quietSeconds: 180 }
const powerShell51 =
  process.platform === 'win32' &&
  (await runProcess({
    program: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']
  })
    .then((result) => result.code === 0)
    .catch(() => false))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** A lock younger than the stale window, quiet for `quietMinutes`, naming `owner`. */
function lockOwnedBy(owner: string, quietMinutes: number): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-exited-owner-steal-'))
  roots.push(root)
  const lock = join(root, '.install-lock')
  mkdirSync(lock)
  writeFileSync(join(lock, OWNER), owner)
  const at = new Date(Date.now() - quietMinutes * 60_000)
  utimesSync(lock, at, at)
  return lock
}

async function steal(
  host: RemoteHostPlatform,
  lock: string,
  mutationLock?: string
): Promise<string> {
  const command = tryStealInstallLockCommand(host, lock, 20 * 60, successor, {
    ...exitedOwner,
    mutationLock
  })
  const result =
    host.os === 'win32'
      ? await runProcess({
          program: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-Command', decodeRemotePowerShellScript(command)]
        })
      : await runProcess({ program: '/bin/sh', args: ['-c', command] })
  return result.stdout.trim()
}

// BUG-23 / Astra 26087: the steal itself checks the exited holder's token and quiet, inside its
// arbitration, on the very lock instance it then moves aside.
describe.each([
  ['POSIX', process.platform !== 'win32', getRemoteHostPlatform('linux-x64')],
  ['Windows PowerShell 5.1', powerShell51, getRemoteHostPlatform('win32-x64')]
] as const)('a %s steal naming an exited holder', (_name, runs, host) => {
  it.runIf(runs)('takes a quiet lock that still names that holder', async () => {
    const lock = lockOwnedBy('t-exited', 10)
    expect(await steal(host, lock)).toBe('EXITED_OWNER_OK')
    expect(readFileSync(join(lock, OWNER), 'utf8')).toBe('t-relaunch')
  })

  it.runIf(runs)('keeps a lock another holder now owns, however quiet', async () => {
    const lock = lockOwnedBy('live-successor', 10)
    expect(await steal(host, lock)).toBe('BUSY')
    expect(readFileSync(join(lock, OWNER), 'utf8')).toBe('live-successor')
  })

  it.runIf(runs)('keeps a lock that is not yet quiet', async () => {
    const lock = lockOwnedBy('t-exited', 1)
    expect(await steal(host, lock)).toBe('BUSY')
  })

  it.runIf(runs)('lets only one concurrent caller take it', async () => {
    const lock = lockOwnedBy('t-exited', 10)
    const outputs = await Promise.all(Array.from({ length: 8 }, () => steal(host, lock)))
    expect(outputs.filter((output) => output.endsWith('OK'))).toHaveLength(1)
    expect(readdirSync(join(lock, '..')).filter((name) => name.includes('.tombstone'))).toEqual([])
  })

  // The fence scope: the steal holds the state-mutation lock across the takeover (Astra 26087 r2).
  it.runIf(runs)(
    'takes a fence only while no state-mutation lock exists, and releases it',
    async () => {
      const lock = lockOwnedBy('t-exited', 10)
      const mutationLock = join(lock, '..', 'orcad-state-mutation.lock')
      mkdirSync(mutationLock)
      expect(await steal(host, lock, mutationLock)).toBe('BUSY')
      expect(readFileSync(join(lock, OWNER), 'utf8')).toBe('t-exited')
      rmSync(mutationLock, { recursive: true })
      expect(await steal(host, lock, mutationLock)).toBe('EXITED_OWNER_OK')
      expect(readFileSync(join(lock, OWNER), 'utf8')).toBe('t-relaunch')
      expect(existsSync(mutationLock)).toBe(false)
    }
  )
})
