import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'

const { handlers, mainRenderer } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  mainRenderer: { isDestroyed: () => false, send: () => undefined }
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/test/user-data' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  }
}))
// Why: registration only captures the runtime; a bare class keeps the real runtime graph out.
vi.mock('../../runtime/orca-runtime', () => ({ OrcaRuntimeService: class {} }))
vi.mock('../ui', () => ({ getTrustedUIRendererWebContents: () => mainRenderer }))
vi.mock('./skill-install-management-ipc-handlers', () => ({
  registerSkillInstallManagementIpcHandlers: vi.fn()
}))
vi.mock('../runtime-environments/requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: vi.fn()
}))

import { registerSkillCloudIpcHandlers } from './skill-cloud-ipc-handlers'

describe('skill cloud IPC share link origins', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('reports the configured artifacts origin for share links, and none when it is invalid', () => {
    handlers.clear()
    registerSkillCloudIpcHandlers(new OrcaRuntimeService(), vi.fn())
    const origins = handlers.get('skills:shareLinkOrigins')!
    vi.stubEnv('ORCA_ARTIFACTS_API_URL', 'https://share-staging.onorca.dev')
    expect(origins({ sender: mainRenderer })).toEqual(['https://share-staging.onorca.dev'])
    vi.stubEnv('ORCA_ARTIFACTS_API_URL', 'https://share.example.com')
    expect(origins({ sender: mainRenderer })).toEqual([])
  })
})
