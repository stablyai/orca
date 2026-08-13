import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { upsertEphemeralVmRuntime } from '../shared/ephemeral-vm-runtime-store'
import { removeEphemeralVmRuntimeSshTarget } from './ephemeral-vm-runtime-ssh-cleanup'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('retains the hidden target identity when removal fails', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-ssh-cleanup-'))
  tempDirs.push(userDataPath)
  const runtime = upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-1',
    recipeId: 'cloud-sandbox',
    status: 'cleanup_failed',
    cleanupStatus: 'failed',
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
    }
  })

  await expect(
    removeEphemeralVmRuntimeSshTarget({
      userDataPath,
      runtime,
      removeTarget: vi.fn().mockRejectedValue(new Error('store unavailable'))
    })
  ).resolves.toMatchObject({ sshTargetId: 'runtime-ssh-1', connectionMode: 'ssh' })
})

it('keeps a completed provider cleanup visible and retryable until target removal succeeds', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-ssh-cleanup-'))
  tempDirs.push(userDataPath)
  const runtime = upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-1',
    recipeId: 'cloud-sandbox',
    status: 'cleaned',
    cleanupStatus: 'succeeded',
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
    }
  })
  const failed = await removeEphemeralVmRuntimeSshTarget({
    userDataPath,
    runtime,
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
  ).resolves.toMatchObject({ status: 'cleaned', cleanupStatus: 'succeeded' })
})
