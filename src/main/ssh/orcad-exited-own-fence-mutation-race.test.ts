import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { hostname, tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import type * as DeployHelpers from './ssh-relay-deploy-helpers'

// The proof's remote commands run in a real local shell.
vi.mock('./ssh-relay-deploy-helpers', async (importOriginal) => {
  const { runProcess: run } = await import('../../shared/child-process/run-process')
  return {
    ...(await importOriginal<typeof DeployHelpers>()),
    execCommand: async (_conn: unknown, command: string) =>
      (await run({ program: '/bin/sh', args: ['-c', command] })).stdout
  }
})

const { exitedOwnLockProof } = await import('./orcad-exited-own-lock')
const { initOrcadHeldFenceTokenFile, ORCAD_HELD_FENCE_TOKENS_FILE_NAME } =
  await import('./orcad-held-fence-tokens')
const { tryStealInstallLockCommand } = await import('./ssh-relay-install-lock-commands')
const { serializedStateMutationCommand } = await import('./orcad-state-snapshot')
const { ORCAD_FENCE_LOST_EXIT, ORCAD_FENCE_LOST_MARKER } =
  await import('./orcad-activation-fence-scope')
const { getRemoteHostPlatform } = await import('./ssh-remote-platform')

const OWNER = '.orca-fence-owner'
// Above every Linux and macOS pid_max, so no process can hold it.
const EXITED_PID = 4_194_304 + 1
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    writeFileSync(join(dir, 'resume'), '')
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A quiet fence an exited desktop process left, and the steal a relaunch would run on it. */
async function fenceOfExitedHolder() {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-fence-mutation-race-'))
  dirs.push(dir)
  const lock = join(dir, '.orcad-activation-transaction', '.install-lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, OWNER), 'old-token')
  const quietSince = new Date(Date.now() - 10 * 60_000)
  utimesSync(lock, quietSince, quietSince)
  mkdirSync(join(dir, 'data'))
  initOrcadHeldFenceTokenFile(join(dir, 'data', 'orca-data.json'))
  writeFileSync(
    join(dir, 'data', ORCAD_HELD_FENCE_TOKENS_FILE_NAME),
    JSON.stringify([
      {
        token: 'old-token',
        pid: EXITED_PID,
        host: hostname(),
        bootedAt: Date.now() - uptime() * 1000,
        at: Date.now()
      }
    ])
  )
  const host = getRemoteHostPlatform('linux-x64')
  const proof = exitedOwnLockProof(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked to a local shell, so the connection is never used.
    { conn: {} as never, host },
    { baseDir: dir, guardsStateMutation: true }
  )
  const token = await proof.find(lock)
  expect(token).toBe('old-token')
  const steal = tryStealInstallLockCommand(
    host,
    lock,
    20 * 60,
    { fileName: OWNER, token: 'new-token' },
    {
      fileName: OWNER,
      token: 'old-token',
      quietSeconds: proof.quietSeconds,
      mutationLock: proof.mutationLock
    }
  )
  // A surviving mutation of the exited run: it passed its outer fence check as 'old-token'.
  const ownerSeen = join(dir, 'owner-seen-by-mutation')
  const mutation = serializedStateMutationCommand(
    dir,
    `: > ${quote(join(dir, 'ready'))}; while [ ! -e ${quote(join(dir, 'resume'))} ]; do sleep 0.01; done; cat ${quote(join(lock, OWNER))} > ${quote(ownerSeen)}`,
    0.05,
    { lockDir: lock, token: 'old-token' }
  )
  writeFileSync(join(dir, 'mutation.sh'), mutation)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  return { dir, lock, steal, ownerSeen, bin }
}

async function waitFor(file: string): Promise<void> {
  await expect.poll(() => existsSync(file), { timeout: 10_000 }).toBe(true)
}

// Astra 26087 round 2: a mutation of the exited run must never keep running under a fence a
// relaunch replaced, whether it is admitted before, during or after the steal.
describe.skipIf(process.platform === 'win32')(
  'an exited holder’s fence and a late mutation',
  () => {
    it('keeps the fence while a mutation admitted after the proof waits for its first heartbeat', async () => {
      const { dir, lock, steal, ownerSeen, bin } = await fenceOfExitedHolder()
      const paused = join(dir, 'paused')
      writeFileSync(
        join(bin, 'touch'),
        `#!/bin/sh\nif [ ! -e ${quote(paused)} ]; then : > ${quote(paused)}; while [ ! -e ${quote(join(dir, 'resume'))} ]; do sleep 0.01; done; fi\nPATH=${quote(process.env.PATH ?? '')} exec touch "$@"\n`,
        { mode: 0o755 }
      )
      const child = spawnProcess({
        program: '/bin/sh',
        args: [join(dir, 'mutation.sh')],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
      })
      const exited = new Promise((resolve) => child.on('exit', resolve))
      await waitFor(paused)
      expect((await runProcess({ program: '/bin/sh', args: ['-c', steal] })).stdout.trim()).toBe(
        'BUSY'
      )
      writeFileSync(join(dir, 'resume'), '')
      await exited
      expect(readFileSync(ownerSeen, 'utf8').trim()).toBe('old-token')
      expect(readFileSync(join(lock, OWNER), 'utf8')).toBe('old-token')
    })

    it('stops a mutation that takes its lock only after the steal replaced the fence', async () => {
      const { dir, lock, steal, ownerSeen, bin } = await fenceOfExitedHolder()
      const mutationLock = join(dir, 'orcad-state-mutation.lock')
      const paused = join(dir, 'paused')
      // The mutation passed its outer fence check and pauses just before taking its lock.
      writeFileSync(
        join(bin, 'mkdir'),
        `#!/bin/sh\nif [ "$1" = ${quote(mutationLock)} ] && [ ! -e ${quote(paused)} ]; then : > ${quote(paused)}; while [ ! -e ${quote(join(dir, 'resume'))} ]; do sleep 0.01; done; fi\nPATH=${quote(process.env.PATH ?? '')} exec mkdir "$@"\n`,
        { mode: 0o755 }
      )
      const mutation = runProcess({
        program: '/bin/sh',
        args: [join(dir, 'mutation.sh')],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
      })
      await waitFor(paused)
      expect((await runProcess({ program: '/bin/sh', args: ['-c', steal] })).stdout.trim()).toBe(
        'EXITED_OWNER_OK'
      )
      writeFileSync(join(dir, 'resume'), '')
      const result = await mutation
      expect(result.code).toBe(ORCAD_FENCE_LOST_EXIT)
      expect(result.stdout.trim().split('\n').at(-1)).toBe(ORCAD_FENCE_LOST_MARKER)
      expect(existsSync(ownerSeen)).toBe(false)
      expect(existsSync(mutationLock)).toBe(false)
      expect(readFileSync(join(lock, OWNER), 'utf8')).toBe('new-token')
    })

    // Astra 26087 r3: a steal stalled past the ownerless-lock age still holds the mutation lock,
    // because it records its pid as a mutation holder does. Backdating stands in for the stall.
    it('keeps a suspended steal’s mutation lock against a mutation however long it stalls', async () => {
      const { dir, lock, steal, ownerSeen, bin } = await fenceOfExitedHolder()
      const mutationLock = join(dir, 'orcad-state-mutation.lock')
      const paused = join(dir, 'paused')
      // Stalls the steal right before it moves the fence, after every check it makes.
      writeFileSync(
        join(bin, 'mv'),
        `#!/bin/sh\nif [ ! -e ${quote(paused)} ]; then : > ${quote(paused)}; while [ ! -e ${quote(join(dir, 'resume'))} ]; do sleep 0.01; done; fi\nPATH=${quote(process.env.PATH ?? '')} exec mv "$@"\n`,
        { mode: 0o755 }
      )
      const stealing = runProcess({
        program: '/bin/sh',
        args: ['-c', steal],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
      })
      await waitFor(paused)
      expect(readFileSync(join(mutationLock, 'pid'), 'utf8').trim()).toMatch(/^\d+$/u)
      const longAgo = new Date(Date.now() - 10 * 60_000)
      utimesSync(mutationLock, longAgo, longAgo)
      const mutation = await runProcess({ program: '/bin/sh', args: [join(dir, 'mutation.sh')] })
      expect(mutation.stdout).toContain('STATE_MUTATION_BUSY')
      expect(existsSync(ownerSeen)).toBe(false)
      writeFileSync(join(dir, 'resume'), '')
      expect((await stealing).stdout.trim()).toBe('EXITED_OWNER_OK')
      expect(readFileSync(join(lock, OWNER), 'utf8')).toBe('new-token')
      expect(existsSync(mutationLock)).toBe(false)
    })

    it.each([
      ['before the steal holds the mutation lock', 2, 'BUSY'],
      ['while the steal holds the mutation lock', 3, 'EXITED_OWNER_OK']
    ])(
      'never overlaps a mutation that starts inside the steal claim %s',
      async (_when, ownerRead, verdict) => {
        const { dir, lock, steal, ownerSeen, bin } = await fenceOfExitedHolder()
        const reads = join(dir, 'owner-reads')
        const finished = join(dir, 'finished')
        writeFileSync(
          join(bin, 'cat'),
          `#!/bin/sh\nif [ "$1" = ${quote(join(lock, OWNER))} ]; then\nprintf x >> ${quote(reads)}\n` +
            `if [ "$(wc -c < ${quote(reads)})" -eq ${ownerRead} ]; then\n` +
            `( PATH=${quote(process.env.PATH ?? '')} /bin/sh ${quote(join(dir, 'mutation.sh'))} > ${quote(join(dir, 'mutation-out'))}; : > ${quote(finished)} ) </dev/null >/dev/null 2>&1 &\n` +
            `while [ ! -e ${quote(join(dir, 'ready'))} ] && [ ! -e ${quote(finished)} ]; do sleep 0.01; done\nfi\nfi\n` +
            `PATH=${quote(process.env.PATH ?? '')} exec cat "$@"\n`,
          { mode: 0o755 }
        )
        const result = await runProcess({
          program: '/bin/sh',
          args: ['-c', steal],
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
        })
        expect(result.stdout.trim()).toBe(verdict)
        writeFileSync(join(dir, 'resume'), '')
        await waitFor(finished)
        if (verdict === 'BUSY') {
          // The mutation held its lock first, so it ran under the fence it was admitted under.
          expect(readFileSync(ownerSeen, 'utf8').trim()).toBe('old-token')
          expect(readFileSync(join(lock, OWNER), 'utf8')).toBe('old-token')
        } else {
          // The steal held the mutation lock, so the mutation never ran.
          expect(readFileSync(join(dir, 'mutation-out'), 'utf8')).toContain('STATE_MUTATION_BUSY')
          expect(existsSync(ownerSeen)).toBe(false)
          expect(readFileSync(join(lock, OWNER), 'utf8')).toBe('new-token')
        }
      }
    )
  }
)
