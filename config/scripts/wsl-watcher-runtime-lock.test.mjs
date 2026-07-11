import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { withRuntimePublicationLock } from './wsl-watcher-runtime-lock.mjs'

async function writeOwner(lockPath, owner) {
  await mkdir(lockPath, { recursive: true })
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify(owner))
  await writeFile(join(lockPath, 'heartbeat'), owner.token)
}

function tokenSequence(...tokens) {
  return vi.fn(() => tokens.shift() ?? `token-${tokens.length}`)
}

describe('WSL runtime publication lock', () => {
  it('promptly reclaims a dead PID identity even with a fresh heartbeat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-wsl-lock-dead-'))
    const lockPath = join(root, 'publish.lock')
    try {
      await writeOwner(lockPath, {
        token: 'dead-owner',
        pid: process.pid,
        processStartToken: 'reused-pid'
      })
      const action = vi.fn()
      await withRuntimePublicationLock(lockPath, action, {
        createToken: tokenSequence('new-owner', 'reclaim', 'release')
      })

      expect(action).toHaveBeenCalledOnce()
      await expect(readFile(lockPath)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never steals a long-held live owner even when its heartbeat is stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-wsl-lock-live-'))
    const lockPath = join(root, 'publish.lock')
    try {
      const liveOwner = { token: 'live-owner', pid: 42, processStartToken: 'live-start' }
      await writeOwner(lockPath, liveOwner)
      await utimes(join(lockPath, 'heartbeat'), new Date(0), new Date(0))

      await expect(
        withRuntimePublicationLock(lockPath, vi.fn(), {
          createToken: tokenSequence('waiter'),
          heartbeatStaleMs: 1,
          ownerIsAlive: async () => true,
          timeoutMs: 0
        })
      ).rejects.toThrow('Timed out waiting')
      await expect(readFile(join(lockPath, 'owner.json'), 'utf8')).resolves.toBe(
        JSON.stringify(liveOwner)
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not release a replacement lock created with a new token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-wsl-lock-aba-'))
    const lockPath = join(root, 'publish.lock')
    const replacement = { token: 'replacement', pid: 77, processStartToken: 'replacement-start' }
    try {
      await withRuntimePublicationLock(
        lockPath,
        async () => {
          await rm(lockPath, { recursive: true, force: true })
          await writeOwner(lockPath, replacement)
        },
        {
          createToken: tokenSequence('original'),
          heartbeatIntervalMs: 60_000
        }
      )

      await expect(readFile(join(lockPath, 'owner.json'), 'utf8')).resolves.toBe(
        JSON.stringify(replacement)
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
