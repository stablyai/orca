import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readDocPreviewFile } from './doc-preview-file-reader'
import {
  authorizeDocPreviewDirectory,
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants
} from './doc-preview-grant-registry'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.call
}))
vi.mock('../../ipc/runtime-environments/runtime-environment-registry-root', () => ({
  getRuntimeEnvironmentRegistryRoot: () => '/user-data'
}))
vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'vps', createdAt: 1, pairingRevision: 12 })
}))

function grant(root = '/tmp/reports'): ReturnType<typeof mintDocPreviewGrant> {
  return mintDocPreviewGrant({
    owner: {
      kind: 'runtime',
      environmentId: 'vps',
      worktreeSelector: 'id:source-workspace',
      worktreeRoot: '/srv/repo',
      fileAccess: 'terminal-artifact'
    },
    requestBase: root,
    root,
    entryRelativePath: 'report.html',
    browserPageId: 'page-1'
  })
}

type HostEntry = { canonical?: string; openTarget?: Record<string, unknown> }

/** The paired host: resolveTerminalPath answers per path, reads answer with `read`. */
function host(entries: Record<string, HostEntry>, read?: unknown): void {
  mocks.call.mockImplementation(
    async (_root: string, _env: string, method: string, params: { pathText?: string }) => {
      if (method !== 'files.resolveTerminalPath') {
        return read
      }
      const path = params.pathText ?? ''
      const entry = entries[path] ?? {}
      const canonical = entry.canonical ?? path
      return {
        ok: true,
        result: {
          absolutePath: canonical,
          openTarget: entry.openTarget ?? {
            kind: 'absolute-file',
            absolutePath: canonical,
            grantId: 'host-grant'
          }
        }
      }
    }
  )
}

function methodsCalled(): string[] {
  return mocks.call.mock.calls.map((call) => String(call[2]))
}

beforeEach(() => {
  vi.resetAllMocks()
  revokeAllDocPreviewGrants()
})

describe('outside-workspace HTML preview', () => {
  it('does not resolve or read neighboring assets until their directory is approved', async () => {
    const page = grant()
    await expect(readDocPreviewFile(page, 'secret.json')).resolves.toMatchObject({
      ok: false,
      status: 403,
      reason: 'authorization-required'
    })
    expect(mocks.call).not.toHaveBeenCalled()

    authorizeDocPreviewDirectory(page.id, 'assets/logo.png')
    host(
      {},
      {
        ok: true,
        result: {
          content: Buffer.from([137, 80, 78, 71]).toString('base64'),
          isBinary: true,
          mimeType: 'image/png'
        }
      }
    )
    await expect(readDocPreviewFile(page, 'assets/logo.png')).resolves.toMatchObject({
      ok: true,
      bytes: Buffer.from([137, 80, 78, 71]),
      contentType: 'image/png'
    })
  })

  it('refuses symlink redirection outside an approved asset directory', async () => {
    const page = grant()
    authorizeDocPreviewDirectory(page.id, 'assets/data.json')
    host({ '/tmp/reports/assets/data.json': { canonical: '/home/dev/.config/credentials.json' } })

    await expect(readDocPreviewFile(page, 'assets/data.json')).resolves.toMatchObject({
      ok: false,
      message: 'The preview file path changed on its host.'
    })
    expect(methodsCalled()).not.toContain('files.readTerminalArtifactPreview')
  })

  // The host canonicalizes these roots, so a nested symlink cannot leave the approved folder.
})
