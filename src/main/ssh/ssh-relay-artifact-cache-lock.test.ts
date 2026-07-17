import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  acquireSshRelayArtifactCacheLock,
  sshRelayArtifactCacheLockPath,
  SSH_RELAY_ARTIFACT_CACHE_LOCK_LIMITS
} from './ssh-relay-artifact-cache-lock'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

const contentId = `sha256:${'a'.repeat(64)}` as SshRelayDigest
const contentHex = contentId.slice('sha256:'.length)
const manualOwnerToken = 'b'.repeat(32)
const successorOwnerToken = 'c'.repeat(32)
const temporaryDirectories: string[] = []
const lockModuleUrl = pathToFileURL(
  join(import.meta.dirname, 'ssh-relay-artifact-cache-lock.ts')
).href

async function runLockChild(root: string): Promise<{
  completed: () => boolean
  result: Promise<{ code: number | null; output: string }>
}> {
  const childScript = `
    import { registerHooks } from 'node:module'
    registerHooks({
      resolve(specifier, context, nextResolve) {
        try {
          return nextResolve(specifier, context)
        } catch (error) {
          if (specifier.startsWith('.')) return nextResolve(specifier + '.ts', context)
          throw error
        }
      }
    })
    const { acquireSshRelayArtifactCacheLock } = await import(${JSON.stringify(lockModuleUrl)})
    const lock = await acquireSshRelayArtifactCacheLock({
      cacheRoot: process.env.ORCA_SSH_RELAY_LOCK_CHILD_ROOT,
      contentId: process.env.ORCA_SSH_RELAY_LOCK_CHILD_CONTENT_ID
    })
    await lock.assertOwned()
    await lock.release()
  `
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--input-type=module',
      '--eval',
      childScript
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ORCA_SSH_RELAY_LOCK_CHILD_ROOT: root,
        ORCA_SSH_RELAY_LOCK_CHILD_CONTENT_ID: contentId
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let done = false
  let output = ''
  child.stdout.on('data', (bytes: Buffer) => (output += bytes.toString('utf8')))
  child.stderr.on('data', (bytes: Buffer) => (output += bytes.toString('utf8')))
  const result = new Promise<{ code: number | null; output: string }>((resolve) => {
    child.on('exit', (code) => {
      done = true
      resolve({ code, output })
    })
  })
  return { completed: () => done, result }
}

async function cacheRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-cache-lock-'))
  temporaryDirectories.push(root)
  return root
}

async function writeManualLock({
  root,
  pid,
  heartbeatAtMs,
  token = manualOwnerToken
}: {
  root: string
  pid: number
  heartbeatAtMs: number
  token?: string
}): Promise<string> {
  const lockPath = sshRelayArtifactCacheLockPath(root, contentId)
  await mkdir(lockPath, { recursive: true, mode: 0o700 })
  await writeFile(
    join(lockPath, 'owner.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      contentId,
      token,
      hostname: hostname(),
      pid,
      acquiredAtMs: heartbeatAtMs,
      heartbeatAtMs
    })}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
  )
  return lockPath
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('SSH relay artifact cache content lock', () => {
  it('pins bounded heartbeat, stale, polling, and acquisition timing', () => {
    expect(SSH_RELAY_ARTIFACT_CACHE_LOCK_LIMITS).toEqual({
      heartbeatIntervalMs: 5_000,
      staleAfterMs: 30_000,
      waitTimeoutMs: 120_000,
      waitPollMs: 100
    })
    expect(Object.isFrozen(SSH_RELAY_ARTIFACT_CACHE_LOCK_LIMITS)).toBe(true)
  })

  it('derives one portable lock path only from an exact lowercase content digest', async () => {
    const root = await cacheRoot()

    expect(sshRelayArtifactCacheLockPath(root, contentId)).toBe(
      join(root, 'locks', `${contentHex}.lock`)
    )
    for (const invalid of [
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'a'.repeat(63)}`,
      `sha256:${'a'.repeat(64)}/../escape`,
      contentHex
    ]) {
      expect(() => sshRelayArtifactCacheLockPath(root, invalid as SshRelayDigest)).toThrow(
        /content id/i
      )
    }
  })

  it('serializes concurrent writers and transfers ownership only after owner release', async () => {
    const root = await cacheRoot()
    const first = await acquireSshRelayArtifactCacheLock({ cacheRoot: root, contentId })
    let secondResolved = false
    const secondPending = acquireSshRelayArtifactCacheLock({ cacheRoot: root, contentId }).then(
      (lock) => {
        secondResolved = true
        return lock
      }
    )

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(secondResolved).toBe(false)
    await first.assertOwned()
    await first.release()

    const second = await secondPending
    expect(second.token).not.toBe(first.token)
    await second.assertOwned()
    await second.release()
  })

  it('serializes a real second process on the same content lock', async () => {
    const root = await cacheRoot()
    const owner = await acquireSshRelayArtifactCacheLock({ cacheRoot: root, contentId })
    const child = await runLockChild(root)

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(child.completed()).toBe(false)
    await owner.release()

    const result = await child.result
    expect(result.code, result.output).toBe(0)
  })

  it('settles a cancelled waiter without disturbing the active owner', async () => {
    const root = await cacheRoot()
    const owner = await acquireSshRelayArtifactCacheLock({ cacheRoot: root, contentId })
    const controller = new AbortController()
    const waiting = acquireSshRelayArtifactCacheLock({
      cacheRoot: root,
      contentId,
      signal: controller.signal
    })

    controller.abort(new Error('cancel cache lock wait'))

    await expect(waiting).rejects.toThrow(/cancel cache lock wait/i)
    await owner.assertOwned()
    await owner.release()
  })

  it('heartbeats through its owned file handle and retains nonce ownership', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const root = await cacheRoot()
    const owner = await acquireSshRelayArtifactCacheLock({ cacheRoot: root, contentId })
    const before = JSON.parse(await readFile(join(owner.lockPath, 'owner.json'), 'utf8')) as {
      heartbeatAtMs: number
    }

    await vi.advanceTimersByTimeAsync(5_000)
    await owner.assertOwned()

    const after = JSON.parse(await readFile(join(owner.lockPath, 'owner.json'), 'utf8')) as {
      heartbeatAtMs: number
      token: string
    }
    expect(before.heartbeatAtMs).toBe(100_000)
    expect(after).toMatchObject({ heartbeatAtMs: 105_000, token: owner.token })
    await owner.release()
  })

  it('atomically tombstones and replaces a stale lock whose local owner is dead', async () => {
    const root = await cacheRoot()
    await writeManualLock({ root, pid: 2_147_483_647, heartbeatAtMs: 0 })

    const replacement = await acquireSshRelayArtifactCacheLock({ cacheRoot: root, contentId })

    expect(replacement.token).not.toBe(manualOwnerToken)
    await replacement.assertOwned()
    await replacement.release()
  })

  it('never reclaims a stale-looking lock whose local owner is still alive', async () => {
    const root = await cacheRoot()
    const lockPath = await writeManualLock({ root, pid: process.pid, heartbeatAtMs: 0 })
    const controller = new AbortController()
    const waiting = acquireSshRelayArtifactCacheLock({
      cacheRoot: root,
      contentId,
      signal: controller.signal
    })
    setTimeout(() => controller.abort(new Error('stop live-owner wait')), 30)

    await expect(waiting).rejects.toThrow(/stop live-owner wait/i)
    const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as {
      token: string
    }
    expect(owner.token).toBe(manualOwnerToken)
  })

  it('preserves an unparseable owner instead of guessing that its writer is dead', async () => {
    const root = await cacheRoot()
    const lockPath = sshRelayArtifactCacheLockPath(root, contentId)
    await mkdir(lockPath, { recursive: true, mode: 0o700 })
    await writeFile(join(lockPath, 'owner.json'), '{not-json', { mode: 0o600 })
    const controller = new AbortController()
    const waiting = acquireSshRelayArtifactCacheLock({
      cacheRoot: root,
      contentId,
      signal: controller.signal
    })
    setTimeout(() => controller.abort(new Error('stop ambiguous-owner wait')), 30)

    await expect(waiting).rejects.toThrow(/stop ambiguous-owner wait/i)
    expect(await readFile(join(lockPath, 'owner.json'), 'utf8')).toBe('{not-json')
  })

  it('does not publish or delete through a lock whose nonce ownership was displaced', async () => {
    const root = await cacheRoot()
    const owner = await acquireSshRelayArtifactCacheLock({ cacheRoot: root, contentId })
    const now = Date.now()
    // Windows forbids renaming a directory with the live heartbeat handle; nonce replacement is portable.
    await writeFile(
      join(owner.lockPath, 'owner.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        contentId,
        token: successorOwnerToken,
        hostname: hostname(),
        pid: process.pid,
        acquiredAtMs: now,
        heartbeatAtMs: now
      })}\n`
    )

    await expect(owner.assertOwned()).rejects.toThrow(/ownership/i)
    await owner.release()

    const successor = JSON.parse(await readFile(join(owner.lockPath, 'owner.json'), 'utf8')) as {
      token: string
    }
    expect(successor.token).toBe(successorOwnerToken)
  })
})
