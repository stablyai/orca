import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readDocPreviewFile } from './doc-preview-file-reader'
import {
  authorizeDocPreviewDirectory,
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants
} from './doc-preview-grant-registry'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.call
}))
vi.mock('../ipc/runtime-environments/runtime-environment-registry-root', () => ({
  getRuntimeEnvironmentRegistryRoot: () => '/user-data'
}))
vi.mock('../../shared/runtime-environment-store', () => ({
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

function resolvedFile(absolutePath: string): unknown {
  return {
    ok: true,
    result: {
      openTarget: { kind: 'absolute-file', absolutePath, grantId: 'host-grant' }
    }
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  revokeAllDocPreviewGrants()
})

describe('outside-workspace HTML preview', () => {
  it.each(['/tmp/reports', 'C:\\reports'])(
    'reads the full document on its owning host: %s',
    async (root) => {
      const filePath = root.startsWith('C:') ? `${root}\\report.html` : `${root}/report.html`
      mocks.call.mockResolvedValueOnce(resolvedFile(filePath)).mockResolvedValueOnce({
        ok: true,
        result: { content: '<h1>remote</h1>', isBinary: false }
      })

      await expect(readDocPreviewFile(grant(root), 'report.html')).resolves.toEqual({
        ok: true,
        bytes: Buffer.from('<h1>remote</h1>'),
        contentType: 'text/html; charset=utf-8'
      })
      expect(mocks.call).toHaveBeenNthCalledWith(
        1,
        '/user-data',
        'vps',
        'files.resolveTerminalPath',
        {
          worktree: 'id:source-workspace',
          pathText: filePath
        },
        15_000,
        12
      )
      expect(mocks.call).toHaveBeenNthCalledWith(
        2,
        '/user-data',
        'vps',
        'files.readTerminalArtifactPreview',
        {
          worktree: 'id:source-workspace',
          grantId: 'host-grant',
          absolutePath: filePath
        },
        15_000,
        12
      )
    }
  )

  it('does not resolve or read neighboring assets until their directory is approved', async () => {
    const page = grant()
    await expect(readDocPreviewFile(page, 'secret.json')).resolves.toMatchObject({
      ok: false,
      status: 403,
      reason: 'authorization-required'
    })
    expect(mocks.call).not.toHaveBeenCalled()

    authorizeDocPreviewDirectory(page.id, 'assets/logo.png')
    mocks.call
      .mockResolvedValueOnce(resolvedFile('/tmp/reports/assets/logo.png'))
      .mockResolvedValueOnce({
        ok: true,
        result: {
          content: Buffer.from([137, 80, 78, 71]).toString('base64'),
          isBinary: true,
          mimeType: 'image/png'
        }
      })
    await expect(readDocPreviewFile(page, 'assets/logo.png')).resolves.toMatchObject({
      ok: true,
      bytes: Buffer.from([137, 80, 78, 71]),
      contentType: 'image/png'
    })
  })

  it('refuses symlink redirection outside an approved asset directory', async () => {
    const page = grant()
    authorizeDocPreviewDirectory(page.id, 'assets/data.json')
    mocks.call.mockResolvedValueOnce(resolvedFile('/home/dev/.config/credentials.json'))

    await expect(readDocPreviewFile(page, 'assets/data.json')).resolves.toMatchObject({
      ok: false,
      message: 'The preview file path changed on its host.'
    })
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('uses directory-scoped reads when an approved asset is inside the source workspace', async () => {
    const page = grant('/srv')
    authorizeDocPreviewDirectory(page.id, 'repo/assets/app.js')
    mocks.call
      .mockResolvedValueOnce({
        ok: true,
        result: {
          openTarget: {
            kind: 'worktree-file',
            absolutePath: '/srv/repo/assets/app.js',
            relativePath: 'assets/app.js'
          }
        }
      })
      .mockResolvedValueOnce({ ok: true, result: { content: 'console.log(1)', isBinary: false } })

    await expect(readDocPreviewFile(page, 'repo/assets/app.js')).resolves.toMatchObject({
      ok: true
    })
    expect(mocks.call).toHaveBeenLastCalledWith(
      '/user-data',
      'vps',
      'files.readDocPreview',
      {
        worktree: 'id:source-workspace',
        relativePath: 'assets/app.js',
        entryRelativePath: 'assets',
        implicitRootRelativePath: null,
        authorizedRootRelativePaths: ['assets']
      },
      15_000,
      12
    )
  })

  it('rejects traversal before contacting the server', async () => {
    await expect(readDocPreviewFile(grant(), '../private.html')).resolves.toMatchObject({
      ok: false,
      status: 404
    })
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('shows an update requirement for a host without absolute-file grants', async () => {
    mocks.call.mockResolvedValueOnce({ ok: true, result: { exists: false } })
    await expect(readDocPreviewFile(grant(), 'report.html')).resolves.toMatchObject({
      ok: false,
      message: 'Update Orca on the paired machine to preview files outside its workspaces.'
    })
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('keeps expired-grant failures on the remote host', async () => {
    mocks.call
      .mockResolvedValueOnce(resolvedFile('/tmp/reports/report.html'))
      .mockResolvedValueOnce({ ok: false, error: { message: 'terminal_file_grant_expired' } })
    await expect(readDocPreviewFile(grant(), 'report.html')).resolves.toMatchObject({
      ok: false,
      message: 'terminal_file_grant_expired'
    })
  })
})
