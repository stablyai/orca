import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  classifyInstallTargetMock,
  createDownloadGrantMock,
  getAllWindowsMock,
  handlers,
  mainRenderer,
  otherRenderer,
  trustedRendererMock,
  installSkillCloudGrantMock,
  registerInstallManagementMock
} = vi.hoisted(() => ({
  classifyInstallTargetMock: vi.fn(),
  createDownloadGrantMock: vi.fn(),
  getAllWindowsMock: vi.fn(),
  mainRenderer: { isDestroyed: vi.fn(() => false), send: vi.fn() },
  otherRenderer: { isDestroyed: vi.fn(() => false), send: vi.fn() },
  trustedRendererMock: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  installSkillCloudGrantMock: vi.fn(),
  registerInstallManagementMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/test/user-data' },
  BrowserWindow: { getAllWindows: getAllWindowsMock },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('./ui', () => ({ getTrustedUIRendererWebContents: trustedRendererMock }))
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
  installSkillCloudGrant: installSkillCloudGrantMock
}))
vi.mock('./skill-install-progress-ipc', () => ({
  sendBundleInstallProgress: vi.fn(),
  sendSkillInstallProgress: vi.fn()
}))
vi.mock('./runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: vi.fn()
}))

import { registerSkillCloudIpcHandlers } from './skill-cloud-ipc-handlers'
import { SkillSharePreparationService } from '../skills/skill-share-preparation-service'

describe('skill cloud IPC', () => {
  beforeEach(() => {
    handlers.clear()
    mainRenderer.isDestroyed.mockReset().mockReturnValue(false)
    mainRenderer.send.mockReset()
    otherRenderer.send.mockReset()
    trustedRendererMock.mockReset().mockReturnValue(mainRenderer)
    getAllWindowsMock.mockReset().mockReturnValue(
      [mainRenderer, otherRenderer].map((webContents) => ({
        isDestroyed: () => webContents.isDestroyed(),
        webContents
      }))
    )
    classifyInstallTargetMock.mockReset().mockResolvedValue('local')
    createDownloadGrantMock.mockReset().mockResolvedValue({
      status: 'unconfigured',
      message: 'not configured'
    })
    registerInstallManagementMock.mockReset()
    installSkillCloudGrantMock.mockReset()
  })

  afterEach(() => vi.restoreAllMocks())

  it('rejects a grant for a different version before installation', async () => {
    createDownloadGrantMock.mockResolvedValue({
      status: 'ok',
      value: { version: { versionId: 'version-latest' } }
    })
    const runtime = { createSkillDownloadGrant: createDownloadGrantMock }
    registerSkillCloudIpcHandlers(runtime as never, vi.fn())
    const installShare = handlers.get('skills:installShare')

    await expect(
      installShare!(
        { sender: mainRenderer },
        {
          shareId: 'share-1',
          versionId: 'version-reviewed',
          operationId: 'operation-1',
          destination: { scope: 'global' }
        }
      )
    ).rejects.toThrow('skill-package-version-mismatch')
    expect(installSkillCloudGrantMock).not.toHaveBeenCalled()
  })

  const preparationId = 'cf38dbdc-bff0-4e87-a7ea-ef81b7edaa1a'

  it('rejects share publication from an unrelated renderer before starting it', () => {
    const publish = vi.spyOn(SkillSharePreparationService.prototype, 'publish')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration captures the runtime; the publish spy never accesses it.
    registerSkillCloudIpcHandlers({} as never, vi.fn())

    expect(() =>
      handlers.get('skills:publishShare')!(
        { sender: otherRenderer },
        { preparationId, releaseNotes: 'Reviewed release' }
      )
    ).toThrow('Unauthorized skill IPC sender')
    expect(publish).not.toHaveBeenCalled()
    expect(mainRenderer.send).not.toHaveBeenCalled()
    expect(otherRenderer.send).not.toHaveBeenCalled()
  })
})
