import { beforeEach, describe, expect, it } from 'vitest'
import {
  getDocPreviewGrant,
  mintDocPreviewGrant,
  resolveCanonicalDocPreviewPath,
  resolveDocPreviewTargetPath,
  revokeAllDocPreviewGrants,
  revokeDocPreviewGrant,
  toRuntimeWorktreeRelativePath,
  type DocPreviewGrant
} from './doc-preview-grant-registry'

const sshOwner = { kind: 'ssh', connectionId: 'ssh-1' } as const

function mintPosixGrant(root = '/srv/repo/docs'): DocPreviewGrant {
  return mintDocPreviewGrant({
    owner: sshOwner,
    root,
    entryRelativePath: 'index.html',
    browserPageId: 'page-1'
  })
}

beforeEach(() => {
  revokeAllDocPreviewGrants()
})

describe('doc preview grants', () => {
  it('mints unguessable ids and looks them up', () => {
    const first = mintPosixGrant()
    const second = mintPosixGrant()

    expect(first.id).toMatch(/^[0-9a-f]{32}$/)
    expect(first.id).not.toBe(second.id)
    expect(getDocPreviewGrant(first.id)).toBe(first)
  })

  it('returns nothing for an unknown or revoked grant', () => {
    const grant = mintPosixGrant()

    expect(getDocPreviewGrant('0'.repeat(32))).toBeNull()
    expect(revokeDocPreviewGrant(grant.id)).toBe(true)
    expect(getDocPreviewGrant(grant.id)).toBeNull()
    expect(revokeDocPreviewGrant(grant.id)).toBe(false)
  })
})

describe('resolveDocPreviewTargetPath', () => {
  it('resolves paths inside the grant root', () => {
    const grant = mintPosixGrant()

    expect(resolveDocPreviewTargetPath(grant, 'index.html')).toBe('/srv/repo/docs/index.html')
    expect(resolveDocPreviewTargetPath(grant, 'assets/logo.png')).toBe(
      '/srv/repo/docs/assets/logo.png'
    )
  })

  it('refuses parent traversal, absolute escapes and empty paths', () => {
    const grant = mintPosixGrant()

    expect(resolveDocPreviewTargetPath(grant, '../secret.env')).toBeNull()
    expect(resolveDocPreviewTargetPath(grant, 'assets/../../secret.env')).toBeNull()
    expect(resolveDocPreviewTargetPath(grant, '..')).toBeNull()
    expect(resolveDocPreviewTargetPath(grant, '')).toBeNull()
    expect(resolveDocPreviewTargetPath(grant, 'a//b')).toBeNull()
  })

  it('refuses backslash and NUL segments that could re-split on the owning host', () => {
    const grant = mintPosixGrant()

    expect(resolveDocPreviewTargetPath(grant, '..\\secret.env')).toBeNull()
    expect(resolveDocPreviewTargetPath(grant, 'index.html\0.png')).toBeNull()
  })

  // Why this is a traversal test and not a containment test: every request path that names a
  // sibling directory has to climb out of the root first, so the `..` segment guard answers it
  // before the prefix check runs. Sibling containment is exercised where it is reachable —
  // against a canonicalized path, below.
  it('refuses a sibling directory by refusing the traversal that reaches it', () => {
    const grant = mintPosixGrant()

    expect(resolveDocPreviewTargetPath(grant, '../docs-private/secret.html')).toBeNull()
  })

  it('keeps a Windows drive root addressable instead of turning it drive-relative', () => {
    const grant = mintDocPreviewGrant({
      owner: sshOwner,
      root: 'C:\\',
      entryRelativePath: 'index.html',
      browserPageId: 'page-1'
    })

    expect(resolveDocPreviewTargetPath(grant, 'index.html')).toBe('C:\\index.html')
  })

  it('follows the owning host path flavor rather than this process platform', () => {
    const windowsGrant = mintDocPreviewGrant({
      owner: sshOwner,
      root: 'C:\\srv\\repo\\docs',
      entryRelativePath: 'index.html',
      browserPageId: 'page-1'
    })

    expect(resolveDocPreviewTargetPath(windowsGrant, 'assets/logo.png')).toBe(
      'C:\\srv\\repo\\docs\\assets\\logo.png'
    )
    expect(resolveDocPreviewTargetPath(windowsGrant, '../secret.env')).toBeNull()
  })

  it('normalizes a trailing separator on the root', () => {
    const grant = mintDocPreviewGrant({
      owner: sshOwner,
      root: '/srv/repo/docs/',
      entryRelativePath: 'index.html',
      browserPageId: 'page-1'
    })

    expect(resolveDocPreviewTargetPath(grant, 'index.html')).toBe('/srv/repo/docs/index.html')
    expect(resolveDocPreviewTargetPath(grant, '../secret.env')).toBeNull()
  })
})

describe('resolveCanonicalDocPreviewPath', () => {
  // Why here and not above: a canonical path is the one input that can name a sibling directory
  // without traversing — the host resolved a symlink to it — so this is where the prefix check
  // is the only thing standing between the grant and `/srv/repo/docs-private`.
  it('refuses a canonical path in a sibling directory that shares the root prefix', async () => {
    const grant = mintPosixGrant()

    await expect(
      resolveCanonicalDocPreviewPath(grant, '/srv/repo/docs/report.html', async (path) =>
        path === grant.root ? path : '/srv/repo/docs-private/secret.html'
      )
    ).resolves.toBeNull()
  })

  it('answers the canonical path when it stays inside the canonical root', async () => {
    const grant = mintPosixGrant()

    await expect(
      resolveCanonicalDocPreviewPath(grant, '/srv/repo/docs/report.html', async (path) => path)
    ).resolves.toBe('/srv/repo/docs/report.html')
  })
})

describe('toRuntimeWorktreeRelativePath', () => {
  it('produces a worktree-relative path for files inside the worktree', () => {
    expect(toRuntimeWorktreeRelativePath('/srv/repo', '/srv/repo/docs/index.html')).toBe(
      'docs/index.html'
    )
  })

  it('rejects paths outside the worktree, which files.read cannot address', () => {
    expect(toRuntimeWorktreeRelativePath('/srv/repo', '/tmp/agent/report.html')).toBeNull()
    expect(toRuntimeWorktreeRelativePath('/srv/repo', '/srv/repo')).toBeNull()
  })

  it('uses Windows semantics for a Windows worktree root', () => {
    expect(toRuntimeWorktreeRelativePath('C:\\srv\\repo', 'C:\\srv\\repo\\docs\\index.html')).toBe(
      'docs/index.html'
    )
    expect(toRuntimeWorktreeRelativePath('C:\\srv\\repo', 'D:\\other\\index.html')).toBeNull()
  })
})
