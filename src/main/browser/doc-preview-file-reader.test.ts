import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn()
}))

vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))
vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: () => '/user-data'
}))

import { docPreviewContentType, readDocPreviewFile } from './doc-preview-file-reader'
import {
  authorizeDocPreviewDirectory,
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants
} from './doc-preview-grant-registry'

// Why the fixtures approve the document directory up front: these tests exercise the transport
// half of a read — an entry-only grant's approval flow is pinned in its own test below.
function sshGrant(): ReturnType<typeof mintDocPreviewGrant> {
  const grant = mintDocPreviewGrant({
    owner: { kind: 'ssh', connectionId: 'ssh-1' },
    root: '/home/alice/docs',
    entryRelativePath: 'index.html',
    browserPageId: 'page-1'
  })
  authorizeDocPreviewDirectory(grant.id, grant.entryRelativePath)
  return grant
}

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

describe('docPreviewContentType', () => {
  it('maps document and asset extensions, defaulting to octet-stream', () => {
    expect(docPreviewContentType('index.html')).toBe('text/html; charset=utf-8')
    expect(docPreviewContentType('assets/app.CSS')).toBe('text/css; charset=utf-8')
    expect(docPreviewContentType('assets/logo.png')).toBe('image/png')
    expect(docPreviewContentType('data.bin')).toBe('application/octet-stream')
  })
})

describe('readDocPreviewFile — ssh owner', () => {
  it('404s with the not-served message instead of reading anything', async () => {
    const grant = sshGrant()

    await expect(readDocPreviewFile(grant, 'index.html')).resolves.toMatchObject({
      ok: false,
      status: 404,
      message: 'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
    })
    expect(mocks.callRuntimeEnvironment).not.toHaveBeenCalled()
  })
})

describe('readDocPreviewFile — paired runtime owner', () => {
  it('reads text over the host-enforced preview method', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: { content: '<h1>remote</h1>', isBinary: false }
    })

    const outcome = await readDocPreviewFile(runtimeGrant(), 'index.html')

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'files.readDocPreview',
      {
        worktree: 'id:wt-1',
        relativePath: 'docs/index.html',
        entryRelativePath: 'docs/index.html',
        implicitRootRelativePath: null,
        authorizedRootRelativePaths: ['docs']
      },
      15_000
    )
    expect(outcome).toEqual({
      ok: true,
      bytes: Buffer.from('<h1>remote</h1>', 'utf8'),
      contentType: 'text/html; charset=utf-8'
    })
  })

  it('reads a base64 asset through the same host-enforced method', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: {
        content: png.toString('base64'),
        isBinary: true,
        mimeType: 'image/png'
      }
    })

    const outcome = await readDocPreviewFile(runtimeGrant(), 'assets/logo.png')

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'files.readDocPreview',
      expect.objectContaining({ relativePath: 'docs/assets/logo.png' }),
      15_000
    )
    expect(outcome).toEqual({ ok: true, bytes: png, contentType: 'image/png' })
  })

  it('fails closed when an old server does not implement the scoped method', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method: files.readDocPreview' }
    })

    expect(await readDocPreviewFile(runtimeGrant(), 'assets/logo.png')).toMatchObject({
      ok: false,
      status: 404,
      reason: 'unreadable',
      // Why: fail-closed is deliberate, so the reader is told the host is old, not that it broke.
      message:
        'Secure document previews require a newer Orca on the paired machine. Update it and try again.'
    })
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledOnce()
  })

  it('serves an empty paired asset the host typed rather than reporting a refusal', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: { content: '', isBinary: true, mimeType: 'image/png' }
    })

    expect(await readDocPreviewFile(runtimeGrant(), 'assets/logo.png')).toEqual({
      ok: true,
      bytes: Buffer.alloc(0),
      contentType: 'image/png'
    })
  })

  it('refuses an over-cap text read instead of serving partial bytes', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: false,
      error: { code: 'runtime_error', message: 'file_too_large' }
    })

    const outcome = await readDocPreviewFile(runtimeGrant(), 'index.html')

    expect(outcome).toMatchObject({ ok: false, status: 413 })
    expect(outcome).not.toMatchObject({ ok: true })
  })

  it('serves a read the host reports as complete', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: { content: '<h1>all</h1>', isBinary: false }
    })

    expect(await readDocPreviewFile(runtimeGrant(), 'index.html')).toMatchObject({ ok: true })
  })

  it('reports the host rejecting an over-cap binary as too large', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: false,
      error: { code: 'runtime_error', message: 'file_too_large' }
    })

    expect(await readDocPreviewFile(runtimeGrant(), 'assets/huge.png')).toMatchObject({
      ok: false,
      status: 413
    })
  })

  it('does not treat an unrelated RPC failure as a binary fallback', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: false,
      error: { code: 'runtime_error', message: 'permission_denied' }
    })

    expect(await readDocPreviewFile(runtimeGrant(), 'index.html')).toMatchObject({
      ok: false,
      status: 404
    })
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledOnce()
  })

  it('404s a document outside the worktree, which files.read cannot address', async () => {
    const outcome = await readDocPreviewFile(runtimeGrant('/tmp/agent-docs'), 'index.html')

    expect(outcome).toMatchObject({ ok: false, status: 404 })
    expect(mocks.callRuntimeEnvironment).not.toHaveBeenCalled()
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
    expect(mocks.callRuntimeEnvironment).not.toHaveBeenCalled()

    authorizeDocPreviewDirectory(grant.id, 'assets/app.js')
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: { content: 'console.log(1)', isBinary: false }
    })

    await expect(readDocPreviewFile(grant, 'assets/app.js')).resolves.toMatchObject({ ok: true })
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'files.readDocPreview',
      {
        worktree: 'id:wt-1',
        relativePath: 'assets/app.js',
        entryRelativePath: 'docs/index.html',
        implicitRootRelativePath: 'docs',
        authorizedRootRelativePaths: ['assets']
      },
      15_000
    )
  })
})
