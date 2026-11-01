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
  it.each(['/tmp/reports', 'C:\\reports'])(
    'reads the full document on its owning host: %s',
    async (root) => {
      const filePath = root.startsWith('C:') ? `${root}\\report.html` : `${root}/report.html`
      host({}, { ok: true, result: { content: '<h1>remote</h1>', isBinary: false } })

      await expect(readDocPreviewFile(grant(root), 'report.html')).resolves.toEqual({
        ok: true,
        bytes: Buffer.from('<h1>remote</h1>'),
        contentType: 'text/html; charset=utf-8'
      })
      expect(mocks.call).toHaveBeenCalledWith(
        '/user-data',
        'vps',
        'files.resolveTerminalPath',
        { worktree: 'id:source-workspace', pathText: filePath },
        15_000,
        12
      )
      expect(mocks.call).toHaveBeenLastCalledWith(
        '/user-data',
        'vps',
        'files.readTerminalArtifactPreview',
        { worktree: 'id:source-workspace', grantId: 'host-grant', absolutePath: filePath },
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

  // A macOS host spells /tmp as /private/tmp and returns a case-insensitive volume's stored name.
  it('reads paths the host spells differently once canonicalized', async () => {
    const page = grant()
    authorizeDocPreviewDirectory(page.id, 'assets/styles.css')
    host(
      {
        '/tmp/reports': { canonical: '/private/tmp/reports' },
        '/tmp/reports/report.html': { canonical: '/private/tmp/reports/report.html' },
        '/tmp/reports/assets': { canonical: '/private/tmp/reports/assets' },
        '/tmp/reports/assets/styles.css': { canonical: '/private/tmp/reports/assets/Styles.css' }
      },
      { ok: true, result: { content: 'h1{}', isBinary: false } }
    )

    await expect(readDocPreviewFile(page, 'report.html')).resolves.toMatchObject({ ok: true })
    await expect(readDocPreviewFile(page, 'assets/styles.css')).resolves.toMatchObject({
      ok: true
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

  it('pages a large approved asset inside the source workspace like a workspace preview', async () => {
    const page = grant('/srv')
    authorizeDocPreviewDirectory(page.id, 'repo/assets/app.js')
    const workspaceParams = {
      worktree: 'id:source-workspace',
      relativePath: 'assets/app.js',
      entryRelativePath: 'assets',
      implicitRootRelativePath: null,
      authorizedRootRelativePaths: ['assets']
    }
    host({
      '/srv/repo/assets/app.js': {
        openTarget: {
          kind: 'worktree-file',
          absolutePath: '/srv/repo/assets/app.js',
          relativePath: 'assets/app.js'
        }
      }
    })
    const bundle = Buffer.from('console.log(1)')
    const resolveOnly = mocks.call.getMockImplementation()
    mocks.call.mockImplementation(async (...args: [string, string, string, unknown]) => {
      if (args[2] === 'files.readDocPreview') {
        return { ok: false, error: { message: 'file_too_large' } }
      }
      if (args[2] === 'files.readDocPreviewChunk') {
        return {
          ok: true,
          result: {
            contentBase64: bundle.toString('base64'),
            size: bundle.length,
            mtimeMs: 1,
            ctimeMs: 1
          }
        }
      }
      return resolveOnly?.(...args)
    })

    await expect(readDocPreviewFile(page, 'repo/assets/app.js')).resolves.toMatchObject({
      ok: true,
      bytes: bundle
    })
    expect(mocks.call).toHaveBeenCalledWith(
      '/user-data',
      'vps',
      'files.readDocPreview',
      workspaceParams,
      15_000
    )
  })

  // The host canonicalizes these roots, so a nested symlink cannot leave the approved folder.
  it.each([
    ['repo/assets/app.js', 'assets', ['assets']],
    ['app.js', 'assets/app.js', ['']]
  ])(
    'asks the host to check approved folders, not the asset folder (approved %s)',
    async (approvedAsset, entryRelativePath, authorizedRootRelativePaths) => {
      const page = grant('/srv')
      authorizeDocPreviewDirectory(page.id, approvedAsset)
      host(
        {
          '/srv/repo/assets/app.js': {
            openTarget: {
              kind: 'worktree-file',
              absolutePath: '/srv/repo/assets/app.js',
              relativePath: 'assets/app.js'
            }
          }
        },
        { ok: true, result: { content: 'console.log(1)', isBinary: false } }
      )

      await readDocPreviewFile(page, 'repo/assets/app.js')
      expect(mocks.call).toHaveBeenLastCalledWith(
        '/user-data',
        'vps',
        'files.readDocPreview',
        {
          worktree: 'id:source-workspace',
          relativePath: 'assets/app.js',
          entryRelativePath,
          implicitRootRelativePath: null,
          authorizedRootRelativePaths
        },
        15_000
      )
    }
  )

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
    host({}, { ok: false, error: { message: 'terminal_file_grant_expired' } })
    await expect(readDocPreviewFile(grant(), 'report.html')).resolves.toMatchObject({
      ok: false,
      message: 'terminal_file_grant_expired'
    })
  })
})
