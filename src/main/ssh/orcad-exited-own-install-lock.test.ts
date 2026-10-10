import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { hostname, tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as DeployHelpers from './ssh-relay-deploy-helpers'

// Every remote command runs in a real local shell, so the host-side checks are the real ones.
vi.mock('./ssh-relay-deploy-helpers', async (importOriginal) => {
  const { runProcess } = await import('@orca/process-host')
  const { sshCommandExitError } = await import('./ssh-relay-exec-command')
  return {
    ...(await importOriginal<typeof DeployHelpers>()),
    execCommand: async (_conn: unknown, command: string) => {
      const result = await runProcess({ program: '/bin/sh', args: ['-c', command] })
      if (result.code !== 0) {
        throw sshCommandExitError(command, result.code ?? 1, result.stdout)
      }
      return result.stdout
    }
  }
})

const { acquireInstallLock } = await import('./ssh-relay-install-lock')
const { exitedOwnLockProof } = await import('./orcad-exited-own-lock')
const { initOrcadHeldFenceTokenFile, ORCAD_HELD_FENCE_TOKENS_FILE_NAME } =
  await import('./orcad-held-fence-tokens')
const { getRemoteHostPlatform } = await import('./ssh-remote-platform')

// Above every Linux and macOS pid_max, so no process can hold it.
const EXITED_PID = 4_194_304 + 1
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

/** A version dir whose install lock a quit left mid-upload, quiet for ten minutes. */
function versionDirWithLock(owner: string, heldToken: string) {
  const home = mkdtempSync(join(tmpdir(), 'orcad-exited-install-'))
  homes.push(home)
  const dir = join(home, '.orca-remote', 'orcad-0.1.0+aa01')
  const lock = join(dir, '.install-lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, '.orca-fence-owner'), owner)
  const quietSince = new Date(Date.now() - 10 * 60_000)
  utimesSync(lock, quietSince, quietSince)
  mkdirSync(join(home, 'data'))
  initOrcadHeldFenceTokenFile(join(home, 'data', 'orca-data.json'))
  const bootedAt = Date.now() - uptime() * 1000
  writeFileSync(
    join(home, 'data', ORCAD_HELD_FENCE_TOKENS_FILE_NAME),
    JSON.stringify([
      { token: heldToken, pid: EXITED_PID, host: hostname(), bootedAt, at: Date.now() }
    ])
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked to a local shell, so the connection is never used.
  const target = { conn: {} as never, host: getRemoteHostPlatform('linux-x64') }
  const proof = exitedOwnLockProof(target, {
    baseDir: join(home, '.orca-remote'),
    guardsStateMutation: false
  })
  const store = join(home, 'data', ORCAD_HELD_FENCE_TOKENS_FILE_NAME)
  const acquire = (waitTimeoutMs: number, exitedOwner = proof) =>
    acquireInstallLock(target.conn, dir, target.host, {
      waitTimeoutMs,
      owner: { fileName: '.orca-fence-owner', token: 't-relaunch' },
      exitedOwner
    })
  return { lock, store, proof, acquire }
}

// BUG-23: a quit mid-upload left the version dir's install lock, and the relaunch waited 20 minutes.
describe.skipIf(process.platform === 'win32')(
  'an install lock this desktop’s exited process left',
  () => {
    it('is taken over at once', async () => {
      const { lock, store, acquire } = versionDirWithLock('t-exited', 't-exited')
      const started = Date.now()
      await acquire(5_000)
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(readFileSync(join(lock, '.orca-fence-owner'), 'utf-8')).toBe('t-relaunch')
      expect(readFileSync(store, 'utf-8')).not.toContain('t-exited')
    })

    it('never writes to the lock while proving its holder exited', async () => {
      const { lock, proof } = versionDirWithLock('t-exited', 't-exited')
      const before = statSync(lock).mtimeMs
      await expect(proof.find(lock)).resolves.toBe('t-exited')
      expect(statSync(lock).mtimeMs).toBe(before)
    })

    // Astra 26087: a live successor that replaces the lock after the proof must never be aged or taken.
    it('leaves a successor that replaced the lock after the proof alone', async () => {
      const { lock, store, proof, acquire } = versionDirWithLock('t-exited', 't-exited')
      const replacing = {
        ...proof,
        find: async (lockDir: string) => {
          const token = await proof.find(lockDir)
          rmSync(lock, { recursive: true })
          mkdirSync(lock)
          writeFileSync(join(lock, '.orca-fence-owner'), 'live-successor')
          return token
        }
      }
      await expect(acquire(1_500, replacing)).rejects.toThrow()
      expect(readFileSync(join(lock, '.orca-fence-owner'), 'utf-8')).toBe('live-successor')
      expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(60_000)
      expect(readFileSync(store, 'utf-8')).toContain('t-exited')
    })

    it('is left to the stale window when another desktop holds it', async () => {
      const { lock, acquire } = versionDirWithLock('t-foreign', 't-exited')
      await expect(acquire(1_500)).rejects.toThrow()
      expect(existsSync(lock)).toBe(true)
      expect(readFileSync(join(lock, '.orca-fence-owner'), 'utf-8')).toBe('t-foreign')
    })
  }
)
