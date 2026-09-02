import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { upsertEphemeralVmRuntime } from '../../shared/ephemeral-vm-runtime-store'

const handlers = new Map<string, (_event: unknown, args: { runtimeId: string }) => unknown>()
const { getPathMock, handleMock, removeRuntimeOwnedSshTargetMock, removeHandlerMock } = vi.hoisted(
  () => ({
    getPathMock: vi.fn(),
    handleMock: vi.fn(),
    removeRuntimeOwnedSshTargetMock: vi.fn(),
    removeHandlerMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

vi.mock('../ephemeral-vm-runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: vi.fn(),
  disconnectRuntimeOwnedSshTarget: vi.fn(),
  removeRuntimeOwnedSshTarget: removeRuntimeOwnedSshTargetMock
}))

import { registerEphemeralVmRuntimeHandlers } from './ephemeral-vm-runtime-handlers'

const tempDirs: string[] = []

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

beforeEach(() => {
  handlers.clear()
  handleMock.mockReset()
  removeRuntimeOwnedSshTargetMock.mockReset().mockResolvedValue(undefined)
  removeHandlerMock.mockReset()
  handleMock.mockImplementation(
    (channel: string, handler: (_event: unknown, args: { runtimeId: string }) => unknown) => {
      handlers.set(channel, handler)
    }
  )
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('removes the hidden SSH target when provider cleanup cannot start', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-handler-'))
  tempDirs.push(userDataPath)
  getPathMock.mockReturnValue(userDataPath)
  upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-missing-context',
    recipeId: 'cloud-sandbox',
    repoId: 'missing-repo',
    status: 'cleanup_failed',
    cleanupStatus: 'not_started',
    connectionMode: 'ssh',
    sshTargetId: 'runtime-ssh-missing-context',
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
  registerEphemeralVmRuntimeHandlers({ getRepo: vi.fn() } as never)

  const cleaned = await handlers.get('ephemeralVm:cleanup')?.(null, {
    runtimeId: 'runtime-missing-context'
  })

  expect(cleaned).toMatchObject({
    status: 'cleanup_failed',
    cleanupStatus: 'failed',
    connectionMode: undefined,
    sshTargetId: undefined
  })
  expect(removeRuntimeOwnedSshTargetMock).toHaveBeenCalledWith('runtime-ssh-missing-context')
})

it('stops in-flight cleanup and retains the runtime for retry', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-handler-'))
  const repoPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-repo-'))
  tempDirs.push(userDataPath, repoPath)
  getPathMock.mockReturnValue(userDataPath)
  const destroyPath = join(repoPath, 'destroy.js')
  const destroyStartedPath = join(repoPath, 'destroy-started.txt')
  writeFileSync(
    destroyPath,
    `require('fs').writeFileSync(${JSON.stringify(destroyStartedPath)}, 'yes'); setInterval(() => {}, 1000)`
  )
  upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-stop',
    recipeId: 'cloud-sandbox',
    recipe: {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      create: 'unused',
      destroy: nodeCommand(destroyPath)
    },
    repoId: 'repo-1',
    status: 'running',
    cleanupStatus: 'not_started',
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
  registerEphemeralVmRuntimeHandlers({
    getRepo: vi.fn(() => ({
      id: 'repo-1',
      path: repoPath,
      displayName: 'Repo',
      badgeColor: '#000',
      addedAt: 0
    }))
  } as never)

  const cleanup = handlers.get('ephemeralVm:cleanup')?.(null, {
    runtimeId: 'runtime-stop'
  }) as Promise<{ status: string }>
  await vi.waitFor(() => expect(existsSync(destroyStartedPath)).toBe(true))
  const stopped = await handlers.get('ephemeralVm:stopCleanup')?.(null, {
    runtimeId: 'runtime-stop'
  })

  expect(stopped).toMatchObject({
    status: 'cleanup_failed',
    cleanupStatus: 'failed',
    cleanupLastError: 'Cleanup stopped by user.'
  })
  await expect(cleanup).resolves.toMatchObject({ status: 'cleanup_failed' })
})
