import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  classifyInstallTargetMock,
  createDownloadGrantMock,
  handlers,
  registerInstallManagementMock
} = vi.hoisted(() => ({
  classifyInstallTargetMock: vi.fn(),
  createDownloadGrantMock: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  registerInstallManagementMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/test/user-data' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('./skill-ipc-main-window', () => ({
  handleMainWindowSkillIpc: (channel: string, handler: (...args: unknown[]) => unknown) =>
    handlers.set(channel, handler)
}))
vi.mock('./skill-install-management-ipc-handlers', () => ({
  registerSkillInstallManagementIpcHandlers: registerInstallManagementMock
}))
vi.mock('../skills/skill-cloud-install-target', () => ({
  classifySkillCloudInstallTarget: classifyInstallTargetMock
}))
vi.mock('../skills/skill-runtime-capability', () => ({
  supportsSkillRuntimeBundleInstall: vi.fn(),
  supportsSkillRuntimeCancellation: vi.fn(),
  supportsSkillRuntimeInstall: vi.fn()
}))
vi.mock('../skills/skill-cloud-grant-installation', () => ({
  installSkillBundleCloudGrant: vi.fn(),
  installSkillCloudGrant: vi.fn()
}))
vi.mock('./skill-install-progress-ipc', () => ({
  sendBundleInstallProgress: vi.fn(),
  sendSkillInstallProgress: vi.fn()
}))
vi.mock('./runtime-environment-transport-routing', () => ({ callRuntimeEnvironment: vi.fn() }))

import { registerSkillCloudIpcHandlers } from './skill-cloud-ipc-handlers'

describe('skill cloud IPC', () => {
  beforeEach(() => {
    handlers.clear()
    classifyInstallTargetMock.mockReset().mockResolvedValue('local')
    createDownloadGrantMock.mockReset().mockResolvedValue({
      status: 'unconfigured',
      message: 'not configured'
    })
    registerInstallManagementMock.mockReset()
  })

  it('requests a grant for the exact reviewed share version', async () => {
    const runtime = { createSkillDownloadGrant: createDownloadGrantMock }
    registerSkillCloudIpcHandlers(runtime as never, vi.fn())
    const installShare = handlers.get('skills:installShare')
    expect(installShare).toBeDefined()

    await installShare!(
      { sender: {} },
      {
        shareId: 'share-1',
        versionId: 'version-reviewed',
        operationId: 'operation-1',
        destination: { scope: 'global' }
      }
    )

    expect(createDownloadGrantMock).toHaveBeenCalledWith('share-1', {
      versionId: 'version-reviewed',
      installTarget: 'local'
    })
  })
})
