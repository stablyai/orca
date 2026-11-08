import { beforeEach, describe, expect, it } from 'vitest'
import {
  authorizeDocPreviewDirectory,
  mintDocPreviewGrant,
  resolveCanonicalDocPreviewPath,
  resolveDocPreviewTargetPath,
  revokeAllDocPreviewGrants
} from './doc-preview-grant-registry'

const sshOwner = { kind: 'ssh', connectionId: 'ssh-1' } as const

beforeEach(() => {
  revokeAllDocPreviewGrants()
})

describe('resolveDocPreviewTargetPath', () => {
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
