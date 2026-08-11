import { describe, expect, it } from 'vitest'
import type { WorkspacePortScanResult } from '../../shared/workspace-ports'
import {
  buildPreviewLabels,
  buildPreviewPortUrl,
  enrichScanWithPreviewUrls,
  parsePreviewDomain,
  parsePreviewHost,
  type PreviewWorktreeDescriptor
} from './worktree-preview-routes'

function descriptor(overrides: Partial<PreviewWorktreeDescriptor>): PreviewWorktreeDescriptor {
  return {
    worktreeId: 'repo::/w/feat',
    repoId: 'repo',
    projectName: 'orca',
    worktreeName: 'feat',
    worktreePath: '/w/feat',
    ...overrides
  }
}

describe('parsePreviewDomain', () => {
  it('defaults to https and lowercases the host', () => {
    expect(parsePreviewDomain('Preview.Example.COM')).toEqual({
      protocol: 'https',
      host: 'preview.example.com',
      port: null
    })
  })

  it('keeps an explicit scheme and port', () => {
    expect(parsePreviewDomain('http://preview.lan:8443')).toEqual({
      protocol: 'http',
      host: 'preview.lan',
      port: 8443
    })
  })

  it.each(['', 'ftp://x.example', 'preview.example.com/path', '*.example.com'])(
    'rejects %j',
    (raw) => {
      expect(() => parsePreviewDomain(raw)).toThrow()
    }
  )
})

describe('buildPreviewLabels', () => {
  it('derives labels from worktree names and disambiguates collisions deterministically', () => {
    const labels = buildPreviewLabels([
      descriptor({
        worktreeId: 'repo::/w/b/feat',
        worktreeName: 'feat',
        worktreePath: '/w/b/feat'
      }),
      descriptor({ worktreeId: 'repo::/w/a/feat', worktreeName: 'feat', worktreePath: '/w/a/feat' })
    ])
    // Sorted by worktreeId: /w/a claims the base label regardless of input order.
    expect(labels.get('repo::/w/a/feat')).toBe('feat')
    expect(labels.get('repo::/w/b/feat')).toBe('feat-2')
  })

  it('labels a primary worktree with the project name', () => {
    const labels = buildPreviewLabels([
      descriptor({ worktreeId: 'repo::/w/main', worktreeName: 'main', worktreePath: '/w/main' })
    ])
    expect(labels.get('repo::/w/main')).toBe('orca-main')
  })
})

describe('parsePreviewHost', () => {
  const origin = parsePreviewDomain('preview.example.com')

  it('extracts the label and explicit port suffix', () => {
    expect(parsePreviewHost('feat--5173.preview.example.com', origin)).toEqual({
      label: 'feat',
      port: 5173
    })
  })

  it('routes a bare label to the primary port', () => {
    expect(parsePreviewHost('feat-login.preview.example.com:443', origin)).toEqual({
      label: 'feat-login',
      port: null
    })
  })

  it.each([
    'preview.example.com',
    'a.b.preview.example.com',
    'feat.other.example.com',
    'fe_at.preview.example.com'
  ])('rejects %j', (host) => {
    expect(parsePreviewHost(host, origin)).toBeNull()
  })

  it('keeps an out-of-range port suffix as part of the label', () => {
    expect(parsePreviewHost('feat--99999.preview.example.com', origin)).toEqual({
      label: 'feat--99999',
      port: null
    })
  })
})

describe('buildPreviewPortUrl', () => {
  const origin = parsePreviewDomain('https://preview.example.com')

  it('embeds the token as a query parameter', () => {
    expect(buildPreviewPortUrl({ origin, label: 'feat', port: 5173, token: 'secret' })).toBe(
      'https://feat--5173.preview.example.com/?orca-preview-token=secret'
    )
  })

  it('carries an explicit origin port', () => {
    const withPort = parsePreviewDomain('http://preview.lan:8443')
    expect(buildPreviewPortUrl({ origin: withPort, label: 'feat', port: 3000, token: null })).toBe(
      'http://feat--3000.preview.lan:8443/'
    )
  })
})

describe('enrichScanWithPreviewUrls', () => {
  const origin = parsePreviewDomain('https://preview.example.com')
  const owner = {
    worktreeId: 'repo::/w/feat',
    repoId: 'repo',
    displayName: 'feat',
    path: '/w/feat',
    confidence: 'cwd' as const
  }
  const scan: WorkspacePortScanResult = {
    platform: 'linux',
    scannedAt: 1,
    ports: [
      {
        id: 'a',
        bindHost: '127.0.0.1',
        connectHost: 'localhost',
        port: 5173,
        protocol: 'http',
        kind: 'workspace',
        owner
      },
      {
        id: 'b',
        bindHost: '127.0.0.1',
        connectHost: 'localhost',
        port: 8443,
        protocol: 'https',
        kind: 'workspace',
        owner
      },
      {
        id: 'c',
        bindHost: '127.0.0.1',
        connectHost: 'localhost',
        port: 9000,
        protocol: 'unknown',
        kind: 'external'
      }
    ]
  }

  it('adds preview URLs only to previewable workspace ports', () => {
    const enriched = enrichScanWithPreviewUrls(scan, [descriptor({})], { origin, token: 'tok' })
    const [http, https, external] = enriched.ports
    expect(http).toMatchObject({
      previewUrl: 'https://feat--5173.preview.example.com/?orca-preview-token=tok'
    })
    expect('previewUrl' in https).toBe(false)
    expect('previewUrl' in external).toBe(false)
  })

  it('leaves ports without a matching descriptor untouched', () => {
    const enriched = enrichScanWithPreviewUrls(scan, [], { origin, token: null })
    expect(enriched.ports.every((port) => !('previewUrl' in port))).toBe(true)
  })
})
