import { describe, expect, it } from 'vitest'
import { DEFAULT_EGRESS_PRESET, EDITOR_REMOTE_SERVER_HOSTS, compileNetworkPolicy, gitBasicAuthorization, parseEgressPreset } from '../src/network-policy'

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

  it('adds the wildcard only in open mode', () => {
    expect(compileNetworkPolicy({ mode: 'open', allowlist: [] })).toEqual({ allow: { '*': [] } })
    expect(compileNetworkPolicy({ mode: 'allowlist' }).allow['*']).toBeUndefined()
  })

  it('open mode lists only hosts with rules, and credential hosts keep their claims and trailing deny', () => {
    const policy = compileNetworkPolicy({
      mode: 'open',
      credentials: [
        {
          host: 'github.com',
          header: 'authorization',
          placeholders: [gitBasicAuthorization('orca-ph-1')],
          via: 'transform',
          value: gitBasicAuthorization('ghs_real')
        },
        { host: 'api.anthropic.com', header: 'x-api-key', placeholders: ['orca-ph-a'], via: 'forward', forwardURL: 'https://cp.dev/v1/egress/proxy' },
        { host: 'api2.cursor.sh', header: 'authorization', placeholders: ['Bearer orca-ph-c'], via: 'forward', forwardURL: 'https://cp.dev/v1/egress/proxy', allowUnclaimed: true }
      ]
    })
    expect(Object.keys(policy.allow).sort()).toEqual(['*', 'api.anthropic.com', 'api2.cursor.sh', 'github.com'])
    expect(policy.allow['*']).toEqual([])
    expect(policy.allow['github.com']).toEqual([
      {
        match: { headers: [{ key: { exact: 'authorization' }, value: { exact: 'Basic eC1hY2Nlc3MtdG9rZW46b3JjYS1waC0x' } }] },
        transform: [{ headers: { authorization: 'Basic eC1hY2Nlc3MtdG9rZW46Z2hzX3JlYWw=' } }]
      },
      deny
    ])
    expect(policy.allow['api.anthropic.com']).toEqual([
      { match: { headers: [{ key: { exact: 'x-api-key' }, value: { exact: 'orca-ph-a' } }] }, forwardURL: 'https://cp.dev/v1/egress/proxy' },
      deny
    ])
    expect(policy.allow['api2.cursor.sh']).toEqual([
      { match: { headers: [{ key: { exact: 'authorization' }, value: { exact: 'Bearer orca-ph-c' } }] }, forwardURL: 'https://cp.dev/v1/egress/proxy' }
    ])
  })

  it('defaults workspace sandboxes to open egress; limited is an explicit operator choice', () => {
    expect(DEFAULT_EGRESS_PRESET).toBe('open')
    expect(parseEgressPreset(undefined)).toBe('open')
    expect(parseEgressPreset('bogus')).toBe('open')
    expect(parseEgressPreset(' Limited ')).toBe('limited')
    expect(parseEgressPreset('open')).toBe('open')
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
