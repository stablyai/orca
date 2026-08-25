import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  callRuntimeEnvironmentMock,
  handleMock,
  supportsBundleInstallMock,
  supportsManagementMock
} = vi.hoisted(() => ({
  callRuntimeEnvironmentMock: vi.fn(),
  handleMock: vi.fn(),
  supportsBundleInstallMock: vi.fn(),
  supportsManagementMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/test/user-data' },
  ipcMain: { handle: handleMock }
}))

vi.mock('./skill-ipc-main-window', () => ({
  handleMainWindowSkillIpc: (channel: string, handler: unknown) => handleMock(channel, handler)
}))

vi.mock('./runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))

vi.mock('../skills/skill-runtime-capability', () => ({
  supportsSkillRuntimeBundleInstall: supportsBundleInstallMock,
  supportsSkillRuntimeManagement: supportsManagementMock
}))

vi.mock('../wsl', () => ({ listWslDistrosAsync: vi.fn(async () => []) }))

import { registerSkillInstallManagementIpcHandlers } from './skill-install-management-ipc-handlers'

type IpcHandler = (_event: unknown, value: unknown) => Promise<unknown>

async function waitForCalls(count: number): Promise<void> {
  for (
    let attempt = 0;
    attempt < 100 && callRuntimeEnvironmentMock.mock.calls.length < count;
    attempt += 1
  ) {
    await Promise.resolve()
  }
  expect(callRuntimeEnvironmentMock).toHaveBeenCalledTimes(count)
}

describe('skill install management IPC', () => {
  const handlers = new Map<string, IpcHandler>()

  beforeEach(() => {
    handlers.clear()
    callRuntimeEnvironmentMock.mockReset()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    })
    supportsBundleInstallMock.mockReset().mockResolvedValue(true)
    supportsManagementMock.mockReset().mockResolvedValue(true)
  })

  it('bounds remote bundle preview requests', async () => {
    const pending: (() => void)[] = []
    let active = 0
    let peakActive = 0
    callRuntimeEnvironmentMock.mockImplementation(
      async (
        _root,
        _environment,
        _method,
        request: { name: string; package: { packageDigest: string } }
      ) => {
        active += 1
        peakActive = Math.max(peakActive, active)
        await new Promise<void>((resolve) => pending.push(resolve))
        active -= 1
        return {
          ok: true,
          result: {
            name: request.name,
            packageDigest: request.package.packageDigest,
            destinationIdentity: 'global:remote-1',
            currentState: 'missing',
            providers: []
          }
        }
      }
    )
    registerSkillInstallManagementIpcHandlers({} as never)
    const handler = handlers.get('skills:previewBundleInstall')
    expect(handler).toBeDefined()
    const selectedSkills = Array.from({ length: 17 }, (_, index) => ({
      id: `skill-${index}`,
      name: `skill-${index}`,
      digest: 'a'.repeat(64)
    }))

    const preview = handler!(null, {
      environmentId: 'remote-1',
      package: {
        packageId: 'package-1',
        versionId: 'version-1',
        bundleDigest: 'c'.repeat(64),
        archiveSha256: 'b'.repeat(64),
        compressedBytes: 100
      },
      selectedSkills,
      destination: { scope: 'global' }
    })

    await waitForCalls(8)
    expect(peakActive).toBe(8)
    pending.splice(0).forEach((resolve) => resolve())
    await waitForCalls(16)
    expect(peakActive).toBe(8)
    pending.splice(0).forEach((resolve) => resolve())
    await waitForCalls(17)
    expect(peakActive).toBe(8)
    pending.splice(0).forEach((resolve) => resolve())

    await expect(preview).resolves.toMatchObject({
      status: 'ok',
      value: { skills: expect.arrayContaining([expect.objectContaining({ name: 'skill-16' })]) }
    })
  })
})
