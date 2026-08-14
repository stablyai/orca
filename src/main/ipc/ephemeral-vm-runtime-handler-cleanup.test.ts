import { mkdtempSync, rmSync } from 'node:fs'
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

it('removes the hidden SSH target when recipe context is unavailable', async () => {
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
    sshTargetId: undefined
  })
  expect(removeRuntimeOwnedSshTargetMock).toHaveBeenCalledWith('runtime-ssh-missing-context')
})
