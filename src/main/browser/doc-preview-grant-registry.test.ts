import { beforeEach, describe, expect, it } from 'vitest'
import {
  authorizeDocPreviewDirectory,
  getDocPreviewGrant,
  mintDocPreviewGrant,
  resolveCanonicalDocPreviewPath,
  resolveDocPreviewTargetPath,
  revokeAllDocPreviewGrants,
  revokeDocPreviewGrant,
  toRuntimeWorktreeRelativeDirectoryPath,
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
  // A grant whose root IS its request base — a document at the workspace root, or outside any
  // workspace — starts with the entry file alone: that directory is where secrets live, and a
  // DNS-prefetch beacon needs no click, so nothing beside the entry reads without the reader.
  it('reads only the entry document until the reader approves its directory', () => {
    const grant = mintPosixGrant()

    expect(resolveDocPreviewTargetPath(grant, 'index.html')).toBe('/srv/repo/docs/index.html')
    expect(resolveDocPreviewTargetPath(grant, 'assets/logo.png')).toBeNull()
    expect(resolveDocPreviewTargetPath(grant, 'secrets.env')).toBeNull()

    expect(authorizeDocPreviewDirectory(grant.id, 'assets/logo.png')).toBe(true)
    expect(resolveDocPreviewTargetPath(grant, 'assets/logo.png')).toBe(
      '/srv/repo/docs/assets/logo.png'
    )
    expect(resolveDocPreviewTargetPath(grant, 'secrets.env')).toBeNull()
  })

  it('keeps silent authority over a document directory strictly inside the workspace, and only there', () => {
    const nested = mintDocPreviewGrant({
      owner: sshOwner,
      requestBase: '/srv/repo',
      root: '/srv/repo/docs',
      entryRelativePath: 'docs/report.html',
      browserPageId: 'page-1'
    })
    expect(resolveDocPreviewTargetPath(nested, 'docs/styles.css')).toBe('/srv/repo/docs/styles.css')

    const atWorkspaceRoot = mintDocPreviewGrant({
      owner: sshOwner,
      requestBase: '/srv/repo',
      root: '/srv/repo',
      entryRelativePath: 'report.html',
      browserPageId: 'page-2'
    })
    expect(resolveDocPreviewTargetPath(atWorkspaceRoot, 'report.html')).toBe(
      '/srv/repo/report.html'
    )
    expect(resolveDocPreviewTargetPath(atWorkspaceRoot, '.env')).toBeNull()
    expect(resolveDocPreviewTargetPath(atWorkspaceRoot, 'docs/styles.css')).toBeNull()
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

    expect(authorizeDocPreviewDirectory(windowsGrant.id, 'assets/logo.png')).toBe(true)
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

  it('authorizes only the requested sibling directory', () => {
    const grant = mintDocPreviewGrant({
      owner: sshOwner,
      requestBase: '/srv/repo',
      root: '/srv/repo/docs',
      entryRelativePath: 'docs/report.html',
      browserPageId: 'page-1'
    })

    expect(resolveDocPreviewTargetPath(grant, 'docs/report.html')).toBe(
      '/srv/repo/docs/report.html'
    )
    expect(resolveDocPreviewTargetPath(grant, 'assets/chart.js')).toBeNull()
    expect(resolveDocPreviewTargetPath(grant, '.env')).toBeNull()

    expect(authorizeDocPreviewDirectory(grant.id, 'assets/chart.js')).toBe(true)
    expect(resolveDocPreviewTargetPath(grant, 'assets/chart.js')).toBe('/srv/repo/assets/chart.js')
    expect(resolveDocPreviewTargetPath(grant, 'assets/theme.css')).toBe(
      '/srv/repo/assets/theme.css'
    )
    expect(resolveDocPreviewTargetPath(grant, '.env')).toBeNull()
  })

  it('refuses malformed authorization requests and unknown grants', () => {
    const grant = mintDocPreviewGrant({
      owner: sshOwner,
      requestBase: '/srv/repo',
      root: '/srv/repo/docs',
      entryRelativePath: 'docs/report.html',
      browserPageId: 'page-1'
    })

    expect(authorizeDocPreviewDirectory(grant.id, '../outside/secret.txt')).toBe(false)
    expect(authorizeDocPreviewDirectory(grant.id, 'assets\\secret.txt')).toBe(false)
    expect(authorizeDocPreviewDirectory('0'.repeat(32), 'assets/chart.js')).toBe(false)
    expect(grant.authorizedRoots).toEqual([])
  })

  it('uses Windows semantics when authorizing a sibling directory', () => {
    const grant = mintDocPreviewGrant({
      owner: sshOwner,
      requestBase: 'C:\\srv\\repo',
      root: 'C:\\srv\\repo\\docs',
      entryRelativePath: 'docs/report.html',
      browserPageId: 'page-1'
    })

    expect(authorizeDocPreviewDirectory(grant.id, 'assets/chart.js')).toBe(true)
    expect(resolveDocPreviewTargetPath(grant, 'assets/chart.js')).toBe(
      'C:\\srv\\repo\\assets\\chart.js'
    )
    expect(authorizeDocPreviewDirectory(grant.id, '../outside/secret.txt')).toBe(false)
  })
})

describe('resolveCanonicalDocPreviewPath', () => {
  // Why here and not above: a canonical path is the one input that can name a sibling directory
  // without traversing — the host resolved a symlink to it — so this is where the prefix check
  // is the only thing standing between the grant and `/srv/repo/docs-private`.
  it('refuses a canonical path in a sibling directory that shares the root prefix', async () => {
    const grant = mintPosixGrant()

    await expect(
      resolveCanonicalDocPreviewPath(grant, '/srv/repo/docs/index.html', async (path) =>
        path === grant.root ? path : '/srv/repo/docs-private/secret.html'
      )
    ).resolves.toBeNull()
  })

  it('answers the canonical path when it stays inside the canonical root', async () => {
    const grant = mintPosixGrant()

    await expect(
      resolveCanonicalDocPreviewPath(grant, '/srv/repo/docs/index.html', async (path) => path)
    ).resolves.toBe('/srv/repo/docs/index.html')
  })

  it('refuses a sibling of an entry-only document even when it canonicalizes cleanly', async () => {
    const grant = mintPosixGrant()

    await expect(
      resolveCanonicalDocPreviewPath(grant, '/srv/repo/docs/notes.txt', async (path) => path)
    ).resolves.toBeNull()
  })

  it('keeps an approved SSH directory inside the canonical workspace boundary', async () => {
    const grant = mintDocPreviewGrant({
      owner: sshOwner,
      requestBase: '/srv/repo',
      root: '/srv/repo/docs',
      entryRelativePath: 'docs/report.html',
      browserPageId: 'page-1'
    })
    authorizeDocPreviewDirectory(grant.id, 'assets/chart.js')

    await expect(
      resolveCanonicalDocPreviewPath(grant, '/srv/repo/assets/chart.js', async (path) => {
        if (path === '/srv/repo/assets') {
          return '/srv/repo/assets'
        }
        if (path === '/srv/repo/assets/chart.js') {
          return '/etc/shadow'
        }
        return path
      })
    ).resolves.toBeNull()
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

  it('represents an explicitly authorized worktree root as the empty relative directory', () => {
    expect(toRuntimeWorktreeRelativeDirectoryPath('/srv/repo', '/srv/repo')).toBe('')
    expect(toRuntimeWorktreeRelativeDirectoryPath('C:\\srv\\repo', 'C:\\srv\\repo')).toBe('')
  })
})
