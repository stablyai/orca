import { describe, expect, it } from 'vitest'
import { compileNetworkPolicy, gitBasicAuthorization } from '../src/network-policy'

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
})
