import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { upsertEphemeralVmRuntime } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { removeEphemeralVmRuntimeSshTarget } from './ephemeral-vm-runtime-ssh-cleanup'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createRuntime(
  userDataPath: string,
  status: 'cleaned' | 'cleanup_failed',
  overrides: Partial<EphemeralVmRuntimeRecord> = {}
): EphemeralVmRuntimeRecord {
  return upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-1',
    recipeId: 'cloud-sandbox',
    status,
    cleanupStatus: status === 'cleaned' ? 'succeeded' : 'failed',
    connectionMode: 'ssh',
    sshTargetId: 'runtime-ssh-1',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/repo',
        target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
      }
    },
    ...overrides
  })
}

it('retains the hidden target identity when removal fails', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-ssh-cleanup-'))
  tempDirs.push(userDataPath)

  await expect(
    removeEphemeralVmRuntimeSshTarget({
      userDataPath,
      runtime: createRuntime(userDataPath, 'cleanup_failed'),
      removeTarget: vi.fn().mockRejectedValue(new Error('store unavailable'))
    })
  ).resolves.toMatchObject({
    status: 'cleanup_failed',
    sshTargetId: 'runtime-ssh-1',
    cleanupLastError: 'Failed to remove the hidden SSH target.'
  })
})

it('keeps provider cleanup retryable until target removal succeeds', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-ssh-cleanup-'))
  tempDirs.push(userDataPath)
  const failed = await removeEphemeralVmRuntimeSshTarget({
    userDataPath,
    runtime: createRuntime(userDataPath, 'cleaned'),
    removeTarget: vi.fn().mockRejectedValue(new Error('store unavailable'))
  })

  expect(failed).toMatchObject({
    status: 'cleanup_failed',
    cleanupStatus: 'succeeded',
    sshTargetId: 'runtime-ssh-1'
  })
  await expect(
    removeEphemeralVmRuntimeSshTarget({
      userDataPath,
      runtime: failed,
      removeTarget: vi.fn().mockResolvedValue(undefined)
    })
  ).resolves.toMatchObject({
    status: 'cleaned',
    cleanupStatus: 'succeeded',
    sshTargetId: undefined
  })
})

it('preserves the provider destroy error after target removal', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-ssh-cleanup-'))
  tempDirs.push(userDataPath)
  const runtime = createRuntime(userDataPath, 'cleanup_failed', {
    cleanupStatus: 'failed',
    cleanupLastError: 'Destroy failed.'
  })

  await expect(
    removeEphemeralVmRuntimeSshTarget({
      userDataPath,
      runtime,
      removeTarget: vi.fn().mockResolvedValue(undefined)
    })
  ).resolves.toMatchObject({
    status: 'cleanup_failed',
    cleanupStatus: 'failed',
    cleanupLastError: 'Destroy failed.',
    sshTargetId: undefined
  })
})

it('does not let a stale concurrent failure regress completed cleanup', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-ssh-cleanup-'))
  tempDirs.push(userDataPath)
  const runtime = createRuntime(userDataPath, 'cleaned')
  let rejectStaleRemoval!: (error: Error) => void
  const staleRemoval = removeEphemeralVmRuntimeSshTarget({
    userDataPath,
    runtime,
    removeTarget: vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStaleRemoval = reject
        })
    )
  })
  await Promise.resolve()

  await removeEphemeralVmRuntimeSshTarget({
    userDataPath,
    runtime,
    removeTarget: vi.fn().mockResolvedValue(undefined)
  })
  rejectStaleRemoval(new Error('stale removal failed'))

  const cleaned = await staleRemoval
  expect(cleaned).toMatchObject({
    status: 'cleaned',
    cleanupStatus: 'succeeded'
  })
  expect(cleaned).not.toHaveProperty('sshTargetId')
})

it('repairs completed cleanup records that already lost their target id', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-ssh-cleanup-'))
  tempDirs.push(userDataPath)
  const runtime = createRuntime(userDataPath, 'cleanup_failed', {
    cleanupStatus: 'succeeded',
    sshTargetId: undefined
  })

  await expect(
    removeEphemeralVmRuntimeSshTarget({
      userDataPath,
      runtime,
      removeTarget: vi.fn()
    })
  ).resolves.toMatchObject({
    status: 'cleaned',
    cleanupStatus: 'succeeded',
    sshTargetId: undefined
  })
})
