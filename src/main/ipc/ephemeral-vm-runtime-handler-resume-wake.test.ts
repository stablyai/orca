import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { upsertEphemeralVmRuntime } from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import type { Store } from '../persistence'

type ResumeWorkspaceArgs = { workspaceId: string }

const handlers = new Map<string, (_event: unknown, args: ResumeWorkspaceArgs) => unknown>()
const { getPathMock, handleMock, removeHandlerMock, wakeMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(),
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  wakeMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

vi.mock('../ephemeral-vm-runtime-wake', () => ({
  ensureEphemeralVmRuntimeControlConnection: wakeMock
}))

import { registerEphemeralVmRuntimeHandlers } from './ephemeral-vm-runtime-handlers'

const tempDirs: string[] = []

function storeStub(): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only getRepo is reachable on the paths under test; the wake branch returns before any recipe context is resolved.
  return { getRepo: vi.fn() } as unknown as Store
}

function runtimeRecord(
  overrides: Partial<EphemeralVmRuntimeRecord> = {}
): EphemeralVmRuntimeRecord {
  return {
    id: 'runtime-wake-test',
    recipeId: 'proxmox-lxc',
    repoId: 'repo-wake-test',
    workspaceId: 'workspace-wake',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'orca-server',
        pairingCode: 'pairing-code',
        projectRoot: '/workspace/orca'
      }
    },
    ...overrides
  }
}

beforeEach(() => {
  handlers.clear()
  handleMock.mockReset()
  removeHandlerMock.mockReset()
  wakeMock.mockReset()
  handleMock.mockImplementation(
    (channel: string, handler: (_event: unknown, args: ResumeWorkspaceArgs) => unknown) => {
      handlers.set(channel, handler)
    }
  )
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function seedRuntime(record: EphemeralVmRuntimeRecord): Promise<void> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-resume-wake-'))
  tempDirs.push(userDataPath)
  getPathMock.mockReturnValue(userDataPath)
  upsertEphemeralVmRuntime(userDataPath, record)
}

async function resumeWorkspace(): Promise<unknown> {
  return handlers.get('ephemeralVm:resumeWorkspace')?.(null, { workspaceId: 'workspace-wake' })
}

it('verifies the control connection of a running runtime before returning it', async () => {
  await seedRuntime(runtimeRecord({ runtimeEnvironmentId: 'environment-wake' }))
  wakeMock.mockResolvedValue({ ok: true })
  registerEphemeralVmRuntimeHandlers(storeStub())

  await expect(resumeWorkspace()).resolves.toMatchObject({ status: 'running' })
  expect(wakeMock).toHaveBeenCalledTimes(1)
  expect(wakeMock.mock.calls[0][0].runtimeEnvironmentId).toBe('environment-wake')
})

it('verifies the control connection of a suspend-failed runtime before returning it', async () => {
  await seedRuntime(
    runtimeRecord({ status: 'suspend_failed', runtimeEnvironmentId: 'environment-wake' })
  )
  wakeMock.mockResolvedValue({ ok: true })
  registerEphemeralVmRuntimeHandlers(storeStub())

  await expect(resumeWorkspace()).resolves.toMatchObject({ status: 'suspend_failed' })
  expect(wakeMock).toHaveBeenCalledTimes(1)
  expect(wakeMock.mock.calls[0][0].runtimeEnvironmentId).toBe('environment-wake')
})

it('rejects when a running runtime cannot re-establish its control connection', async () => {
  await seedRuntime(runtimeRecord({ runtimeEnvironmentId: 'environment-wake' }))
  wakeMock.mockResolvedValue({ ok: false, connectionState: 'awaiting_authenticated' })
  registerEphemeralVmRuntimeHandlers(storeStub())

  await expect(resumeWorkspace()).rejects.toThrow(
    /its Orca Server connection could not be re-established \(awaiting_authenticated\)/
  )
})

it('skips the wake check for a provisioning runtime', async () => {
  await seedRuntime(
    runtimeRecord({ status: 'provisioning', runtimeEnvironmentId: 'environment-wake' })
  )
  registerEphemeralVmRuntimeHandlers(storeStub())

  await expect(resumeWorkspace()).resolves.toMatchObject({ status: 'provisioning' })
  expect(wakeMock).not.toHaveBeenCalled()
})

it('skips the wake check when a running runtime has no environment', async () => {
  await seedRuntime(runtimeRecord({ runtimeEnvironmentId: undefined }))
  registerEphemeralVmRuntimeHandlers(storeStub())

  await expect(resumeWorkspace()).resolves.toMatchObject({ status: 'running' })
  expect(wakeMock).not.toHaveBeenCalled()
})
