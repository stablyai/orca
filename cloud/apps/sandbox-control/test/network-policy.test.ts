import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EGRESS_ALLOWLIST,
  EDITOR_REMOTE_SERVER_HOSTS,
  compileNetworkPolicy,
  egressAllowlistFor,
  gitBasicAuthorization
} from '../src/network-policy'

const deny = { response: { statusCode: 403, body: 'orca-egress-denied', contentType: 'text/plain' } }

describe('compileNetworkPolicy', () => {
  it('fails closed: no wildcard, and credential hosts end with a deny rule', () => {
    const policy = compileNetworkPolicy({
      mode: 'allowlist',
      allowlist: ['registry.npmjs.org', 'github.com'],
      credentials: [
        {
          host: 'github.com',
          header: 'Authorization',
          placeholders: [gitBasicAuthorization('orca-ph-1')],
          via: 'transform',
          value: gitBasicAuthorization('ghs_real')
        },
        {
          host: 'api.github.com',
          header: 'authorization',
          placeholders: ['Bearer orca-ph-1', 'token orca-ph-1'],
          via: 'forward',
          forwardURL: 'https://sandbox.onorca.dev/v1/egress/proxy'
        }
      ]
    })
    expect(policy).toEqual({
      allow: {
        'registry.npmjs.org': [],
        'github.com': [
          {
            match: { headers: [{ key: { exact: 'authorization' }, value: { exact: 'Basic eC1hY2Nlc3MtdG9rZW46b3JjYS1waC0x' } }] },
            transform: [{ headers: { authorization: 'Basic eC1hY2Nlc3MtdG9rZW46Z2hzX3JlYWw=' } }]
          },
          deny
        ],
        'api.github.com': [
          {
            match: { headers: [{ key: { exact: 'authorization' }, value: { exact: 'Bearer orca-ph-1' } }] },
            forwardURL: 'https://sandbox.onorca.dev/v1/egress/proxy'
          },
          {
            match: { headers: [{ key: { exact: 'authorization' }, value: { exact: 'token orca-ph-1' } }] },
            forwardURL: 'https://sandbox.onorca.dev/v1/egress/proxy'
          },
          deny
        ]
      }
    })
  })

  it('allows github.com by default so public repos clone without a GitHub App install', () => {
    expect(compileNetworkPolicy({ mode: 'allowlist' }).allow['github.com']).toEqual([])
  })

  it('adds the wildcard only when a workspace opts into open egress', () => {
    expect(compileNetworkPolicy({ mode: 'open', allowlist: [] })).toEqual({ allow: { '*': [] } })
  })

  it('rejects malformed hosts and wildcard credential hosts', () => {
    expect(() => compileNetworkPolicy({ mode: 'allowlist', allowlist: ['https://x.com'] })).toThrow()
    expect(() =>
      compileNetworkPolicy({
        mode: 'allowlist',
        allowlist: [],
        credentials: [{ host: '*.github.com', header: 'authorization', placeholders: ['p'], via: 'transform', value: 'v' }]
      })
    ).toThrow(/exact host/)
  })

  it('lets editors reach their Remote-SSH server downloads by default, still without a wildcard', () => {
    const { allow } = compileNetworkPolicy({ mode: 'allowlist' })
    for (const host of ['update.code.visualstudio.com', 'vscode.download.prss.microsoft.com', 'cursor.blob.core.windows.net']) {
      expect(EDITOR_REMOTE_SERVER_HOSTS).toContain(host)
      expect(allow[host]).toEqual([])
    }
    expect(allow['*']).toBeUndefined()
  })
})

describe('ORCA_PLATFORM_HOST_SUFFIXES', () => {
  it('unset (or blank) keeps the default allowlist exactly as before', () => {
    const editorAt = DEFAULT_EGRESS_ALLOWLIST.length - EDITOR_REMOTE_SERVER_HOSTS.length
    expect(DEFAULT_EGRESS_ALLOWLIST).toHaveLength(56)
    expect(DEFAULT_EGRESS_ALLOWLIST.slice(editorAt - 2, editorAt)).toEqual(['*.githubcopilot.com', '*.onorca.dev'])
    expect(DEFAULT_EGRESS_ALLOWLIST.slice(editorAt)).toEqual(EDITOR_REMOTE_SERVER_HOSTS)
    for (const unset of [undefined, '', ' , ']) {
      expect(egressAllowlistFor(unset)).toEqual(DEFAULT_EGRESS_ALLOWLIST)
    }
  })

  it('replaces the platform hosts with the configured suffixes, once each', () => {
    const allowlist = egressAllowlistFor(' *.onorca.dev , ,*.example.dev,')
    expect(allowlist.filter((host) => host === '*.onorca.dev')).toHaveLength(1)
    expect(allowlist).toContain('*.example.dev')
    expect(allowlist).toHaveLength(DEFAULT_EGRESS_ALLOWLIST.length + 1)
    expect(egressAllowlistFor('*.example.dev')).not.toContain('*.onorca.dev')
    const { allow } = compileNetworkPolicy({ mode: 'allowlist', allowlist })
    expect(allow['*.onorca.dev']).toEqual([])
    expect(allow['*.example.dev']).toEqual([])
  })
})
