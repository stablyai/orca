import { describe, expect, it } from 'vitest'
import { CODEX_FIREWALL_PATHS, codexPathAllowed } from '../src/codex-paths'
import { compileNetworkPolicy } from '../src/network-policy'

describe('paths', () => {
  it('every firewall path is one the proxy allows too, and none is a prefix', () => {
    for (const { exact, methods } of CODEX_FIREWALL_PATHS) {
      expect(exact.startsWith('/backend-api/')).toBe(true)
      for (const method of methods) {
        expect(codexPathAllowed(method, exact)).toBe(true)
      }
    }
    expect(CODEX_FIREWALL_PATHS.every((path) => !('startsWith' in path))).toBe(true)
  })
})

describe('compileNetworkPolicy: path-scoped claims and path forwards', () => {
  it('one claim per placeholder and path, extra headers alongside the swap, then the forward, then the 403', () => {
    const policy = compileNetworkPolicy({
      mode: 'open',
      credentials: [
        {
          host: 'chatgpt.com',
          header: 'Authorization',
          placeholders: ['Bearer PH'],
          paths: [{ exact: '/a', methods: ['POST'] }, { exact: '/b/c' }],
          via: 'transform',
          value: 'Bearer REAL',
          extraHeaders: { 'chatgpt-account-id': 'acct' }
        },
        { host: 'chatgpt.com', header: 'authorization', placeholders: ['Bearer PH'], via: 'forward', forwardURL: 'https://p.example/x' }
      ],
      pathForwards: [{ host: 'auth.openai.com', path: { exact: '/oauth/token', methods: ['POST'] }, forwardURL: 'https://p.example/x' }]
    })
    const ph = [{ key: { exact: 'authorization' }, value: { exact: 'Bearer PH' } }]
    expect(policy.allow['chatgpt.com']).toEqual([
      { match: { headers: ph, path: { exact: '/a' }, method: ['POST'] }, transform: [{ headers: { 'chatgpt-account-id': 'acct', authorization: 'Bearer REAL' } }] },
      { match: { headers: ph, path: { exact: '/b/c' } }, transform: [{ headers: { 'chatgpt-account-id': 'acct', authorization: 'Bearer REAL' } }] },
      { match: { headers: ph }, forwardURL: 'https://p.example/x' },
      { response: { statusCode: 403, body: 'orca-egress-denied', contentType: 'text/plain' } }
    ])
    // A path forward adds no 403: the rest of auth.openai.com is untouched.
    expect(policy.allow['auth.openai.com']).toEqual([{ match: { path: { exact: '/oauth/token' }, method: ['POST'] }, forwardURL: 'https://p.example/x' }])
  })
})
