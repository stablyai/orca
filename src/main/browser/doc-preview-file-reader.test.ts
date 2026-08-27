import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn(),
  requireSshFilesystemProvider: vi.fn()
}))

vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))
vi.mock('../persistence', () => ({ getCanonicalUserDataPath: () => '/user-data' }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: mocks.requireSshFilesystemProvider
}))

import { FileReadCapExceededError } from '../ssh/ssh-filesystem-stream-reader'
import { docPreviewContentType, readDocPreviewFile } from './doc-preview-file-reader'
import { mintDocPreviewGrant, revokeAllDocPreviewGrants } from './doc-preview-grant-registry'

function sshGrant(): ReturnType<typeof mintDocPreviewGrant> {
  return mintDocPreviewGrant({
    owner: { kind: 'ssh', connectionId: 'ssh-1' },
    root: '/home/alice/docs',
    entryRelativePath: 'index.html',
    browserPageId: 'page-1'
  })
}

function runtimeGrant(root = '/srv/repo/docs'): ReturnType<typeof mintDocPreviewGrant> {
  return mintDocPreviewGrant({
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
}

beforeEach(() => {
  vi.clearAllMocks()
  revokeAllDocPreviewGrants()
  // Why: an unsymlinked host canonicalizes to the path it was given.
  mocks.realpath.mockImplementation((path: string) => Promise.resolve(path))
  mocks.requireSshFilesystemProvider.mockReturnValue({
    readFile: mocks.readFile,
    realpath: mocks.realpath
  })
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
  it('reads text through the SSH filesystem provider', async () => {
    mocks.readFile.mockResolvedValue({ content: '<h1>hi</h1>', isBinary: false })

    const outcome = await readDocPreviewFile(sshGrant(), 'index.html')

    expect(mocks.requireSshFilesystemProvider).toHaveBeenCalledWith('ssh-1')
    expect(mocks.readFile).toHaveBeenCalledWith('/home/alice/docs/index.html')
    expect(outcome).toEqual({
      ok: true,
      bytes: Buffer.from('<h1>hi</h1>', 'utf8'),
      contentType: 'text/html; charset=utf-8'
    })
  })

  it('decodes a base64 binary asset', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    mocks.readFile.mockResolvedValue({ content: png.toString('base64'), isBinary: true })

    const outcome = await readDocPreviewFile(sshGrant(), 'assets/logo.png')

    expect(outcome).toEqual({ ok: true, bytes: png, contentType: 'image/png' })
  })

  // Why: the SSH reader rejects an over-cap file rather than clamping it, so a completed read is
  // always whole and needs no truncation flag.
  it('serves a whole SSH read that carries no truncation flag', async () => {
    mocks.readFile.mockResolvedValue({ content: '<h1>whole</h1>', isBinary: false })

    expect(await readDocPreviewFile(sshGrant(), 'index.html')).toMatchObject({ ok: true })
  })

  // Why: the SSH read path only serves images and PDFs as bytes, so a font is refused there by
  // design — the failure must name the file type, not a stale server.
  it('reports a file type the host will not send as unsupported-asset', async () => {
    mocks.readFile.mockResolvedValue({ content: '', isBinary: true })

    const outcome = await readDocPreviewFile(sshGrant(), 'assets/font.woff2')

    expect(outcome).toMatchObject({ ok: false, status: 415, reason: 'unsupported-asset' })
  })

  // Why: a host that still named the type read a 0-byte file, so 0 bytes is the honest answer —
  // reporting it as a refused format would be a failure the workspace never reported.
  it('serves an empty file the host still typed instead of calling it unsupported', async () => {
    mocks.readFile.mockResolvedValue({ content: '', isBinary: true, mimeType: 'image/png' })

    const outcome = await readDocPreviewFile(sshGrant(), 'assets/logo.png')

    expect(outcome).toEqual({ ok: true, bytes: Buffer.alloc(0), contentType: 'image/png' })
  })

  // Why: containment above is lexical, and the SSH read RPC enforces no root of its own, so a
  // symlink inside the grant would otherwise read anything the account can reach.
  it('404s a path that canonicalizes outside the grant root', async () => {
    mocks.realpath.mockImplementation((path: string) =>
      Promise.resolve(path === '/home/alice/docs/escape.html' ? '/etc/shadow' : path)
    )

    const outcome = await readDocPreviewFile(sshGrant(), 'escape.html')

    expect(outcome).toMatchObject({ ok: false, status: 404 })
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it('reads the canonical path once containment holds', async () => {
    mocks.realpath.mockImplementation((path: string) =>
      Promise.resolve(path === '/home/alice/docs/link.html' ? '/home/alice/docs/real.html' : path)
    )
    mocks.readFile.mockResolvedValue({ content: '<h1>real</h1>', isBinary: false })

    expect(await readDocPreviewFile(sshGrant(), 'link.html')).toMatchObject({ ok: true })
    expect(mocks.readFile).toHaveBeenCalledWith('/home/alice/docs/real.html')
  })

  // Why: a symlinked root is legitimate; containment must be judged on what both sides resolve to.
  it('keeps serving a grant whose own root is a symlink', async () => {
    mocks.realpath.mockImplementation((path: string) =>
      Promise.resolve(path.replace('/home/alice/docs', '/mnt/data/docs'))
    )
    mocks.readFile.mockResolvedValue({ content: '<h1>hi</h1>', isBinary: false })

    expect(await readDocPreviewFile(sshGrant(), 'index.html')).toMatchObject({ ok: true })
    expect(mocks.readFile).toHaveBeenCalledWith('/mnt/data/docs/index.html')
  })

  it('404s when the host cannot canonicalize the path at all', async () => {
    mocks.realpath.mockRejectedValue(new Error('no such file'))

    expect(await readDocPreviewFile(sshGrant(), 'index.html')).toMatchObject({
      ok: false,
      status: 404
    })
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it('404s a path outside the grant root without touching the provider', async () => {
    const outcome = await readDocPreviewFile(sshGrant(), '../../etc/passwd')

    expect(outcome).toMatchObject({ ok: false, status: 404 })
    expect(mocks.requireSshFilesystemProvider).not.toHaveBeenCalled()
  })

  it('reports an over-cap SSH file as too large rather than unreadable', async () => {
    mocks.readFile.mockRejectedValue(new FileReadCapExceededError('exceeds client cap'))

    expect(await readDocPreviewFile(sshGrant(), 'huge.html')).toMatchObject({
      ok: false,
      status: 413
    })
  })

  it('404s when the provider read fails', async () => {
    mocks.readFile.mockRejectedValue(new Error('no such file'))

    expect(await readDocPreviewFile(sshGrant(), 'missing.html')).toMatchObject({
      ok: false,
      status: 404
    })
  })
})

describe('readDocPreviewFile — paired runtime owner', () => {
  it('reads text over worktree-relative files.read', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: { content: '<h1>remote</h1>', truncated: false, byteLength: 15 }
    })

    const outcome = await readDocPreviewFile(runtimeGrant(), 'index.html')

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'files.read',
      { worktree: 'id:wt-1', relativePath: 'docs/index.html' },
      15_000
    )
    expect(outcome).toEqual({
      ok: true,
      bytes: Buffer.from('<h1>remote</h1>', 'utf8'),
      contentType: 'text/html; charset=utf-8'
    })
  })

  it('falls back to the base64 preview RPC for a binary asset', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    mocks.callRuntimeEnvironment
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'runtime_error', message: 'binary_file' }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          content: png.toString('base64'),
          isBinary: true,
          isImage: true,
          mimeType: 'image/png'
        }
      })

    const outcome = await readDocPreviewFile(runtimeGrant(), 'assets/logo.png')

    expect(mocks.callRuntimeEnvironment).toHaveBeenNthCalledWith(
      2,
      '/user-data',
      'env-1',
      'files.readPreview',
      { worktree: 'id:wt-1', relativePath: 'docs/assets/logo.png' },
      15_000
    )
    expect(outcome).toEqual({ ok: true, bytes: png, contentType: 'image/png' })
  })

  it('degrades on an old server whose empty binary preview carries no metadata', async () => {
    mocks.callRuntimeEnvironment
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'runtime_error', message: 'binary_file' }
      })
      .mockResolvedValueOnce({ ok: true, result: { content: '', isBinary: true } })

    expect(await readDocPreviewFile(runtimeGrant(), 'assets/logo.png')).toMatchObject({
      ok: false,
      status: 415,
      reason: 'unsupported-asset'
    })
  })

  it('serves an empty paired asset the host typed rather than reporting a refusal', async () => {
    mocks.callRuntimeEnvironment
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'runtime_error', message: 'binary_file' }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { content: '', isBinary: true, isImage: true, mimeType: 'image/png' }
      })

    expect(await readDocPreviewFile(runtimeGrant(), 'assets/logo.png')).toEqual({
      ok: true,
      bytes: Buffer.alloc(0),
      contentType: 'image/png'
    })
  })

  // Why: files.read clamps text at the host cap and only says so in `truncated`; serving the
  // clamped bytes renders a document that silently stops halfway.
  it('refuses a truncated text read instead of serving the clamped bytes', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: { content: '<h1>half of', truncated: true, byteLength: 40_000_000 }
    })

    const outcome = await readDocPreviewFile(runtimeGrant(), 'index.html')

    expect(outcome).toMatchObject({ ok: false, status: 413 })
    expect(outcome).not.toMatchObject({ ok: true })
  })

  it('serves a read the host reports as complete', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: { content: '<h1>all</h1>', truncated: false, byteLength: 12 }
    })

    expect(await readDocPreviewFile(runtimeGrant(), 'index.html')).toMatchObject({ ok: true })
  })

  // Why: the binary RPC has no `truncated` field — it rejects an over-cap asset with this error.
  it('reports the host rejecting an over-cap binary as too large', async () => {
    mocks.callRuntimeEnvironment
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'runtime_error', message: 'binary_file' }
      })
      .mockResolvedValueOnce({
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
})
