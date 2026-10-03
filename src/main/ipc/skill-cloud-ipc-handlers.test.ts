import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  classifyInstallTargetMock,
  createDownloadGrantMock,
  handlers,
  installSkillCloudGrantMock,
  registerInstallManagementMock
} = vi.hoisted(() => ({
  classifyInstallTargetMock: vi.fn(),
  createDownloadGrantMock: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  installSkillCloudGrantMock: vi.fn(),
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
  installSkillCloudGrant: installSkillCloudGrantMock
}))
vi.mock('./skill-install-progress-ipc', () => ({
  sendBundleInstallProgress: vi.fn(),
  sendSkillInstallProgress: vi.fn()
}))
vi.mock('./runtime-environment-transport-routing', () => ({ callRuntimeEnvironment: vi.fn() }))

import { registerSkillCloudIpcHandlers } from './skill-cloud-ipc-handlers'
import { SkillCloudRequestError } from '../skills/skill-cloud-request'
import { SkillInstallOperationError } from '../skills/skill-install-operation-error'

describe('skill cloud IPC', () => {
  beforeEach(() => {
    handlers.clear()
    classifyInstallTargetMock.mockReset().mockResolvedValue('local')
    createDownloadGrantMock.mockReset().mockResolvedValue({
      status: 'unconfigured',
      message: 'not configured'
    })
    registerInstallManagementMock.mockReset()
    installSkillCloudGrantMock.mockReset()
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

  // The grant call is the first cloud request of an install and it throws: neither
  // `withoutAuth` nor `runSkillCloudOperation` turns a failed request into an
  // operation result. Without classifying it here the renderer sees an unclassified
  // error while the same failure one step later is transport and retryable.
  it('classifies a cloud failure while authorizing, not only during installation', async () => {
    createDownloadGrantMock.mockRejectedValue(
      new SkillCloudRequestError(503, 'unavailable', 'The skill service is unavailable.')
    )
    const runtime = { createSkillDownloadGrant: createDownloadGrantMock }
    registerSkillCloudIpcHandlers(runtime as never, vi.fn())

    const failure = await handlers.get('skills:installShare')!(
      { sender: {} },
      {
        shareId: 'share-1',
        versionId: 'version-reviewed',
        operationId: 'operation-1',
        destination: { scope: 'global' }
      }
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SkillInstallOperationError)
    expect((failure as SkillInstallOperationError).data).toEqual({
      category: 'transport',
      code: 'skill-cloud-request-failed',
      retryable: true
    })
    expect(installSkillCloudGrantMock).not.toHaveBeenCalled()
  })

  it('leaves an unclassifiable authorize failure alone', async () => {
    const raw = new Error('something else entirely')
    createDownloadGrantMock.mockRejectedValue(raw)
    const runtime = { createSkillDownloadGrant: createDownloadGrantMock }
    registerSkillCloudIpcHandlers(runtime as never, vi.fn())

    await expect(
      handlers.get('skills:installShare')!(
        { sender: {} },
        {
          shareId: 'share-1',
          versionId: 'version-reviewed',
          operationId: 'operation-1',
          destination: { scope: 'global' }
        }
      )
    ).rejects.toBe(raw)
  })

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
        { sender: {} },
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
})
