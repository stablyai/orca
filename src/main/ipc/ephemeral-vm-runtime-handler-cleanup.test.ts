import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { upsertEphemeralVmRuntime } from '../../shared/ephemeral-vm-runtime-store'

const handlers = new Map<
  string,
  (_event: unknown, args: { runtimeId?: string; workspaceId?: string }) => unknown
>()
const {
  getPathMock,
  handleMock,
  removeRuntimeOwnedSshTargetMock,
  removeHandlerMock,
  ensureRuntimeOwnedSshTargetAttachedMock
} = vi.hoisted(() => ({
  getPathMock: vi.fn(),
  handleMock: vi.fn(),
  removeRuntimeOwnedSshTargetMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  ensureRuntimeOwnedSshTargetAttachedMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

vi.mock('../ephemeral-vm-runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: vi.fn(),
  disconnectRuntimeOwnedSshTarget: vi.fn(),
  removeRuntimeOwnedSshTarget: removeRuntimeOwnedSshTargetMock
}))
vi.mock('../ephemeral-vm-runtime-ssh-reattach', () => ({
  ensureRuntimeOwnedSshTargetAttached: ensureRuntimeOwnedSshTargetAttachedMock
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
  ensureRuntimeOwnedSshTargetAttachedMock.mockReset().mockResolvedValue(undefined)
  removeHandlerMock.mockReset()
  handleMock.mockImplementation(
    (
      channel: string,
      handler: (_event: unknown, args: { runtimeId?: string; workspaceId?: string }) => unknown
    ) => {
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

function runningSshRuntime(userDataPath: string, id: string, workspaceId: string): void {
  upsertEphemeralVmRuntime(userDataPath, {
    id,
    recipeId: 'cloud-sandbox',
    repoId: 'repo-1',
    workspaceId,
    status: 'running',
    cleanupStatus: 'not_started',
    connectionMode: 'ssh',
    sshTargetId: `runtime-ssh-${id}`,
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/repo',
        target: { label: 'VM', host: '127.0.0.1', port: 2222, username: 'root' }
      }
    }
  })
}

it('re-attaches the SSH relay when a running SSH runtime is activated', async () => {
  // Why: after an app restart the record is still 'running' but no relay exists in this
  // process; the resume gate used to return the record untouched and leave it stranded.
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-handler-'))
  tempDirs.push(userDataPath)
  getPathMock.mockReturnValue(userDataPath)
  runningSshRuntime(userDataPath, 'runtime-restarted', 'workspace-restarted')
  registerEphemeralVmRuntimeHandlers({ getRepo: vi.fn() } as never)

  const resumed = await handlers.get('ephemeralVm:resumeWorkspace')?.(null, {
    workspaceId: 'workspace-restarted'
  })

  expect(ensureRuntimeOwnedSshTargetAttachedMock).toHaveBeenCalledTimes(1)
  expect(ensureRuntimeOwnedSshTargetAttachedMock).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'runtime-restarted',
      sshTargetId: 'runtime-ssh-runtime-restarted'
    })
  )
  expect(resumed).toEqual(expect.objectContaining({ status: 'running' }))
})

it('reports a failed re-attach on activation and leaves the record running', async () => {
  // Why: a relay that will not attach is not evidence the VM is gone; the next activation
  // or terminal spawn retries, so the status must not flip to a resume failure.
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-handler-'))
  tempDirs.push(userDataPath)
  getPathMock.mockReturnValue(userDataPath)
  runningSshRuntime(userDataPath, 'runtime-unreachable', 'workspace-unreachable')
  ensureRuntimeOwnedSshTargetAttachedMock.mockRejectedValue(new Error('connect ECONNREFUSED'))
  registerEphemeralVmRuntimeHandlers({ getRepo: vi.fn() } as never)

  await expect(
    handlers.get('ephemeralVm:resumeWorkspace')?.(null, { workspaceId: 'workspace-unreachable' })
  ).rejects.toThrow('ECONNREFUSED')

  const runtimes = await handlers.get('ephemeralVm:listRuntimes')?.(null, {})
  expect(runtimes).toEqual([
    expect.objectContaining({ id: 'runtime-unreachable', status: 'running' })
  ])
})
