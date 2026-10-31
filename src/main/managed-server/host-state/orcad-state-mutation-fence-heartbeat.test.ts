// Exercise real heartbeats and steal commands so long mutations retain activation ownership.
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
import { runProcess, runProcessSync, spawnProcess } from '@orca/process-host'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import { RELAY_INSTALL_LOCK_NAME } from '../../../shared/relay-install-lock-name'
import { ORCAD_ACTIVATION_TRANSACTION_DIRNAME } from '../activation/orcad-activation-transaction'
import { serializedStateMutationCommand } from './orcad-state-snapshot'
import { posixProcessGroupCommand } from './orcad-state-mutation-owner-record'
import { ORCAD_FENCE_OWNER_FILENAME } from '../activation/orcad-activation-fence-scope'
import { tryStealInstallLockCommand } from '../install/remote-install-lock-commands'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')
const STALE_SECONDS = 3
const HEARTBEAT_SECONDS = 0.1
const OBSERVE_HEARTBEATS_MS = 300

async function sh(command: string): Promise<string> {
  return (await runProcess({ program: '/bin/sh', args: ['-c', command] })).stdout.trim()
}
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const groupExists = (group: number): boolean => {
  try {
    process.kill(-group, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}
const groupHasWork = (group: number): boolean => {
  const result = runProcessSync({
    program: 'ps',
    args: ['-axo', 'pgid=,state='],
    timeoutMs: 2_000
  })
  if (result.code !== 0) {
    return groupExists(group)
  }
  return result.stdout.split('\n').some((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)/)
    return match !== null && Number(match[1]) === group && !match[2]!.startsWith('Z')
  })
}

describe.skipIf(process.platform === 'win32')(
  'the fence heartbeat of a running state mutation',
  () => {
    let base = ''
    let fence = ''
    let ownGroup = 0
    const runs: {
      run: ReturnType<typeof spawnProcess>
      group: number
      closed: boolean
      close: Promise<void>
    }[] = []

    beforeEach(async () => {
      ownGroup = Number(await sh(posixProcessGroupCommand(String(process.pid))))
      expect(ownGroup).toBeGreaterThan(1)
      base = mkdtempSync(join(tmpdir(), 'orcad-fence-beat-'))
      fence = join(base, ORCAD_ACTIVATION_TRANSACTION_DIRNAME, RELAY_INSTALL_LOCK_NAME)
      mkdirSync(fence, { recursive: true })
      writeFileSync(join(fence, ORCAD_FENCE_OWNER_FILENAME), 'holder-1')
    })
    const mutation = (script: string): string =>
      serializedStateMutationCommand(base, script, HEARTBEAT_SECONDS, {
        lockDir: fence,
        token: 'holder-1'
      })
    const startMutation = (script: string, beforeStart = '') => {
      const run = spawnProcess({
        program: '/bin/sh',
        detached: true,
        args: ['-c', beforeStart + mutation(`printf 'ORCA_MUTATION_STARTED\\n' >&2; ${script}`)]
      })
      const tracked: (typeof runs)[number] = {
        run,
        group: 0,
        closed: false,
        close: new Promise<void>((resolve) => {
          run.once('close', () => {
            tracked.closed = true
            resolve()
          })
        })
      }
      runs.push(tracked)
      const started = new Promise<void>((resolve, reject) => {
        let stderr = ''
        run.stderr?.on('data', (chunk: Buffer | string) => {
          stderr += chunk.toString()
          if (!tracked.group && stderr.includes('ORCA_MUTATION_STARTED\n')) {
            try {
              tracked.group = Number(
                readFileSync(join(base, 'orcad-state-mutation.lock', 'pgid'), 'utf8').trim()
              )
              resolve()
            } catch (error) {
              reject(error)
            }
          }
        })
        run.once('error', reject)
        run.once('exit', (code, signal) =>
          reject(new Error(`Mutation exited before readiness: ${code}/${signal}: ${stderr}`))
        )
      })
      return { run, started }
    }
    const stopMutations = async (): Promise<void> => {
      const results = await Promise.allSettled(
        runs.splice(0).map(async (tracked) => {
          const groupFile = join(base, 'orcad-state-mutation.lock', 'pgid')
          const terminateMutationGroup = (): void => {
            if (!tracked.group && existsSync(groupFile)) {
              try {
                tracked.group = Number(readFileSync(groupFile, 'utf8').trim())
              } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
                  throw error
                }
              }
            }
            if (tracked.group > 1) {
              expect(tracked.group).not.toBe(ownGroup)
              if (groupHasWork(tracked.group)) {
                try {
                  process.kill(-tracked.group, 'SIGKILL')
                } catch (error) {
                  if (groupHasWork(tracked.group)) {
                    throw error
                  }
                }
              }
            }
          }
          try {
            terminateMutationGroup()
            if (tracked.group > 1) {
              await expect.poll(() => groupHasWork(tracked.group), { timeout: 5_000 }).toBe(false)
            }
          } finally {
            await forceTerminateProcessTree(tracked.run)
            await expect
              .poll(
                () => {
                  terminateMutationGroup()
                  return tracked.closed && (tracked.group <= 1 || !groupHasWork(tracked.group))
                },
                { timeout: 5_000 }
              )
              .toBe(true)
            await tracked.close
            if (tracked.run.pid) {
              expect(groupHasWork(tracked.run.pid)).toBe(false)
            }
          }
        })
      )
      for (const result of results) {
        if (result.status === 'rejected') {
          throw result.reason
        }
      }
    }
    afterEach(async () => {
      await stopMutations()
      rmSync(base, { recursive: true, force: true })
    })

    const backdate = (): Promise<string> => sh(`touch -m -t 200001010000 '${fence}'`)
    const steal = (): Promise<string> => sh(tryStealInstallLockCommand(posix, fence, STALE_SECONDS))
    const age = (): number => Date.now() / 1000 - statSync(fence).mtimeMs / 1000

    // Real shell startup and gated lock acquisition need this process deadline.
    it('reports readiness only after a delayed startup owns its lock', async () => {
      const gate = join(base, 'allow-mutation')
      const waiting = join(base, 'mutation-waiting')
      const pidFile = join(base, 'orcad-state-mutation.lock', 'pid')
      const { run, started } = startMutation(
        'sleep 6',
        `while [ ! -f '${gate}' ]; do : > '${waiting}'; sleep 0.01; done; `
      )
      let didStart = false
      const ready = started.then(() => {
        didStart = true
      })
      const released = (async () => {
        await expect.poll(() => existsSync(waiting), { timeout: 20_000 }).toBe(true)
        expect(didStart).toBe(false)
        expect(existsSync(pidFile)).toBe(false)
        writeFileSync(gate, 'ready')
      })()
      try {
        await Promise.all([released, ready])
        expect(existsSync(pidFile)).toBe(true)
      } finally {
        run.kill('SIGKILL')
      }
    }, 20_000)

    it('is not stolen while a long mutation runs, and is once its holder dies', async () => {
      const { run, started } = startMutation('sleep 30')
      try {
        await started
        const pidFile = join(base, 'orcad-state-mutation.lock', 'pid')
        await expect
          .poll(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim())
          .toBeTruthy()

        await backdate()
        await expect.poll(age, { timeout: 5_000, interval: 25 }).toBeLessThan(STALE_SECONDS)
        expect(age()).toBeLessThan(STALE_SECONDS)
        expect(await steal()).toBe('BUSY')

        // Kill the owner; subsequent fence freshness must come from no surviving heartbeat.
        process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL')
        await pause(OBSERVE_HEARTBEATS_MS)
        await backdate()
        await pause(OBSERVE_HEARTBEATS_MS)
        expect(age()).toBeGreaterThan(STALE_SECONDS)
        expect(await steal()).toMatch(/OK$/u)
      } finally {
        run.kill('SIGKILL')
      }
    }, 20_000)

    it('stops refreshing a fence another run took over mid-mutation, and keeps its token', async () => {
      const { run, started } = startMutation('sleep 6')
      try {
        await started
        await expect
          .poll(() => existsSync(join(base, 'orcad-state-mutation.lock', 'pid')))
          .toBe(true)
        await backdate()
        await expect.poll(age, { timeout: 5_000, interval: 25 }).toBeLessThan(STALE_SECONDS)
        writeFileSync(join(fence, ORCAD_FENCE_OWNER_FILENAME), 'successor')
        await backdate()
        await pause(OBSERVE_HEARTBEATS_MS)
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
      await sh(mutation('sleep 0.3'))
      await backdate()
      await pause(OBSERVE_HEARTBEATS_MS)
      expect(age()).toBeGreaterThan(STALE_SECONDS)

      rmSync(fence, { recursive: true })
      await sh(serializedStateMutationCommand(base, ':', HEARTBEAT_SECONDS, null))
      expect(existsSync(fence)).toBe(false)
    }, 20_000)

    // Real process-group termination and close need this process deadline.
    it('joins an orphaned mutation group before removing its fixture', async () => {
      const { run, started } = startMutation('sleep 30')
      let closed = false
      run.once('close', () => {
        closed = true
      })
      await started
      const group = Number(
        readFileSync(join(base, 'orcad-state-mutation.lock', 'pgid'), 'utf8').trim()
      )
      expect(group).toBeGreaterThan(1)
      expect(group).not.toBe(ownGroup)
      run.kill('SIGKILL')
      await expect.poll(() => run.signalCode).toBe('SIGKILL')
      expect(groupHasWork(group)).toBe(true)

      await stopMutations()
      expect(groupHasWork(group)).toBe(false)
      expect(closed).toBe(true)
      expect(existsSync(base)).toBe(true)
    }, 20_000)

    // Gated process-group startup and child close need this process deadline.
    it('joins a mutation group published after its outer shell exits', async () => {
      const bin = join(base, 'bin')
      const waiting = join(base, 'group-waiting')
      const gate = join(base, 'publish-group')
      const groupFile = join(base, 'orcad-state-mutation.lock', 'pgid')
      mkdirSync(bin)
      writeFileSync(
        join(bin, 'sh'),
        `#!/bin/sh\nprintf '%s' "$$" > '${waiting}'\n` +
          `while [ ! -f '${gate}' ]; do sleep 0.01; done\nexec /bin/sh "$@"\n`,
        { mode: 0o700 }
      )
      const { run, started } = startMutation('sleep 30', `PATH='${bin}':"$PATH"; export PATH; `)
      void started.catch(() => {})
      let group = 0
      let waitingPid = ''
      try {
        await expect
          .poll(
            () => {
              const pid = existsSync(waiting) ? readFileSync(waiting, 'utf8').trim() : ''
              if (!/^[1-9]\d*$/.test(pid) || Number(pid) <= 1) {
                return false
              }
              waitingPid = pid
              return true
            },
            { timeout: 1_000 }
          )
          .toBe(true)
        group = Number(await sh(posixProcessGroupCommand(waitingPid)))
        expect(group).toBeGreaterThan(1)
        expect(group).not.toBe(ownGroup)
        expect(existsSync(groupFile)).toBe(false)
        run.once('exit', () => writeFileSync(gate, 'publish'))

        await stopMutations()
        expect(existsSync(groupFile)).toBe(true)
        expect(groupHasWork(group)).toBe(false)
        expect(existsSync(base)).toBe(true)
      } finally {
        if (group > 1 && group !== ownGroup && groupHasWork(group)) {
          process.kill(-group, 'SIGKILL')
        }
        await forceTerminateProcessTree(run)
      }
    }, 20_000)

    // Real zombie observation and child close need this process deadline.
    it('does not count an unreaped zombie group as mutation work', async () => {
      const child = spawnProcess({
        program: '/bin/sh',
        args: ['-c', 'exit 0'],
        detached: true,
        stdio: 'ignore'
      })
      let closed = false
      child.once('close', () => {
        closed = true
      })
      if (!child.pid) {
        throw new Error('No owned child PID')
      }
      const group = child.pid
      try {
        const probe = runProcessSync({
          program: '/bin/sh',
          args: [
            '-c',
            `attempt=0; while [ "$attempt" -lt 100 ]; do ` +
              `case "$(ps -o stat= -p ${group} 2>/dev/null)" in *Z*) exit 0;; esac; ` +
              'attempt=$((attempt + 1)); sleep 0.01; done; exit 1'
          ],
          timeoutMs: 3_000
        })
        expect(probe.code).toBe(0)
        const state = runProcessSync({
          program: 'ps',
          args: ['-o', 'pgid=,stat=', '-p', String(group)]
        }).stdout.trim()
        expect(state).toMatch(/\bZ/)
        expect(groupHasWork(group)).toBe(false)
      } finally {
        await forceTerminateProcessTree(child)
        await expect.poll(() => closed, { timeout: 5_000 }).toBe(true)
      }
    }, 20_000)
  }
)
