import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn()
}))

vi.mock('../../ipc/runtime-environments/requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))
vi.mock('../../ipc/runtime-environments/catalog/runtime-environment-registry-root', () => ({
  getRuntimeEnvironmentRegistryRoot: () => '/user-data'
}))
import { readDocPreviewFile } from './doc-preview-file-reader'
import {
  authorizeDocPreviewDirectory,
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants
} from './doc-preview-grant-registry'

function runtimeGrant(root = '/srv/repo/docs'): ReturnType<typeof mintDocPreviewGrant> {
  const grant = mintDocPreviewGrant({
    owner: {
      kind: 'runtime',
      environmentId: 'env-1',
      worktreeSelector: 'id:wt-1',
      worktreeRoot: '/srv/repo'
    },
    root,
    entryRelativePath: 'index.html',
    browserPageId: 'page-1'
  })
  authorizeDocPreviewDirectory(grant.id, grant.entryRelativePath)
  return grant
}

beforeEach(() => {
  vi.clearAllMocks()
  revokeAllDocPreviewGrants()
})

describe('readDocPreviewFile — paired runtime owner', () => {
  function serveTooLargeForOneReply(file: Buffer, version = () => ({ mtimeMs: 1, ctimeMs: 1 })) {
    mocks.callRuntimeEnvironment.mockImplementation(
      async (_root, _env, method: string, params: { offset: number; length: number }) => {
        if (method === 'files.readDocPreview') {
          return { ok: false, error: { code: 'runtime_error', message: 'file_too_large' } }
        }
        const bytes = file.subarray(params.offset, params.offset + params.length)
        return {
          ok: true,
          result: {
            contentBase64: bytes.toString('base64'),
            bytesRead: bytes.length,
            eof: params.offset + bytes.length >= file.length,
            size: file.length,
            ...version()
          }
        }
      }
    )
  }

  it('reads a document too large for one reply by range under the same grant', async () => {
    const html = Buffer.from(`<html>${'x'.repeat(1024 * 1024)}</html>`)
    serveTooLargeForOneReply(html)

    const outcome = await readDocPreviewFile(runtimeGrant(), 'index.html')

    expect(outcome).toEqual({ ok: true, bytes: html, contentType: 'text/html; charset=utf-8' })
  })

  it('refuses a document rewritten between ranges instead of splicing versions', async () => {
    let mtimeMs = 0
    serveTooLargeForOneReply(Buffer.alloc(1024 * 1024, 'x'), () => ({
      mtimeMs: (mtimeMs += 1),
      ctimeMs: 1
    }))

    expect(await readDocPreviewFile(runtimeGrant(), 'index.html')).toMatchObject({
      ok: false,
      status: 404
    })
  })

  it('requires approval for a sibling directory before touching the runtime', async () => {
    const grant = mintDocPreviewGrant({
      owner: {
        kind: 'runtime',
        environmentId: 'env-1',
        worktreeSelector: 'id:wt-1',
        worktreeRoot: '/srv/repo'
      },
      requestBase: '/srv/repo',
      root: '/srv/repo/docs',
      entryRelativePath: 'docs/index.html',
      browserPageId: 'page-1'
    })

    await expect(readDocPreviewFile(grant, 'assets/app.js')).resolves.toMatchObject({
      ok: false,
      status: 403,
      reason: 'authorization-required'
    })

    authorizeDocPreviewDirectory(grant.id, 'assets/app.js')
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: { content: 'console.log(1)', isBinary: false }
    })

    await expect(readDocPreviewFile(grant, 'assets/app.js')).resolves.toMatchObject({ ok: true })
  })
})
