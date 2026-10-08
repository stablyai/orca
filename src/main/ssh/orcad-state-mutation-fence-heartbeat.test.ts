/**
 * A state mutation can outlast the activation fence's stale window, so it keeps the fence
 * fresh while it runs. Run for real with a one-second beat and the real steal command.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import { RELAY_INSTALL_LOCK_NAME } from '../../shared/relay-install-lock-name'
import { ORCAD_ACTIVATION_TRANSACTION_DIRNAME } from './orcad-activation-transaction'
import { serializedStateMutationCommand } from './orcad-state-snapshot'
import { ORCAD_FENCE_OWNER_FILENAME } from './orcad-activation-fence-scope'
import { tryStealInstallLockCommand } from './ssh-relay-install-lock-commands'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')
const STALE_SECONDS = 3

async function sh(command: string): Promise<string> {
  return (await runProcess({ program: '/bin/sh', args: ['-c', command] })).stdout.trim()
}
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(process.platform === 'win32')(
  'the fence heartbeat of a running state mutation',
  () => {
    let base = ''
    let fence = ''

    beforeEach(async () => {
      base = mkdtempSync(join(tmpdir(), 'orcad-fence-beat-'))
      fence = join(base, ORCAD_ACTIVATION_TRANSACTION_DIRNAME, RELAY_INSTALL_LOCK_NAME)
      mkdirSync(fence, { recursive: true })
      writeFileSync(join(fence, ORCAD_FENCE_OWNER_FILENAME), 'holder-1')
    })
    // The mutation runs under the fence its run holds, generation `holder-1`.
    const mutation = (script: string): string =>
      serializedStateMutationCommand(base, script, 1, { lockDir: fence, token: 'holder-1' })
    afterEach(() => {
      rmSync(base, { recursive: true, force: true })
    })

    const backdate = (): Promise<string> => sh(`touch -m -t 200001010000 '${fence}'`)
    const steal = (): Promise<string> => sh(tryStealInstallLockCommand(posix, fence, STALE_SECONDS))
    const age = (): number => Date.now() / 1000 - statSync(fence).mtimeMs / 1000

    it('is not stolen while a long mutation runs, and is once its holder dies', async () => {
      // Stands in for a restore that outlasts the stale window.
      const run = spawnProcess({
        program: '/bin/sh',
        args: ['-c', mutation('sleep 30')]
      })
      try {
        const pidFile = join(base, 'orcad-state-mutation.lock', 'pid')
        await expect
          .poll(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim())
          .toBeTruthy()

        await backdate()
        await pause(2_500)
        expect(age()).toBeLessThan(STALE_SECONDS)
        expect(await steal()).toBe('BUSY')

        // The host process dies (OOM, reboot of the session): nothing refreshes the fence now.
        process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL')
        await pause(1_500)
        await backdate()
        await pause(2_500)
        expect(age()).toBeGreaterThan(STALE_SECONDS)
        expect(await steal()).toMatch(/OK$/u)
      } finally {
        run.kill('SIGKILL')
      }
    }, 20_000)

    it('stops refreshing a fence another run took over mid-mutation, and keeps its token', async () => {
      const run = spawnProcess({ program: '/bin/sh', args: ['-c', mutation('sleep 6')] })
      try {
        await pause(1_500)
        writeFileSync(join(fence, ORCAD_FENCE_OWNER_FILENAME), 'successor')
        await backdate()
        await pause(2_500)
        expect(age()).toBeGreaterThan(STALE_SECONDS)
        expect(readFileSync(join(fence, ORCAD_FENCE_OWNER_FILENAME), 'utf8')).toBe('successor')
      } finally {
        run.kill('SIGKILL')
      }
    }, 20_000)

    it('never starts a mutation once its run no longer owns the fence', async () => {
      writeFileSync(join(fence, ORCAD_FENCE_OWNER_FILENAME), 'successor')
      const marker = join(base, 'mutated')
      expect(await sh(mutation(`touch '${marker}'`))).toBe('__ORCAD_FENCE_LOST__')
      expect(existsSync(marker)).toBe(false)
      expect(existsSync(join(base, 'orcad-state-mutation.lock'))).toBe(false)
    }, 20_000)

    it('stops refreshing once the mutation finishes, and never creates a missing fence', async () => {
      await sh(mutation('sleep 2'))
      await backdate()
      await pause(2_500)
      expect(age()).toBeGreaterThan(STALE_SECONDS)

      rmSync(fence, { recursive: true })
      await sh(serializedStateMutationCommand(base, 'sleep 2', 1, null))
      expect(existsSync(fence)).toBe(false)
    }, 20_000)
  }
)
