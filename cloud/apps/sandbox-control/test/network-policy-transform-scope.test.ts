// Design §4.4: a firewall swap is never scoped by a path prefix, except `/` with GET/HEAD (scoping by method only).
import { describe, expect, it } from 'vitest'
import { compileNetworkPolicy, type CredentialRoute } from '../src/network-policy'

const transform = (paths: CredentialRoute['paths']): CredentialRoute => ({
  host: 'api.github.com',
  header: 'authorization',
  placeholders: ['Bearer orca-ph-x'],
  paths,
  via: 'transform',
  value: 'Bearer real'
})
const compile = (route: CredentialRoute) => () => compileNetworkPolicy({ mode: 'allowlist', allowlist: [], credentials: [route] })

describe('transform claims and path prefixes (§4.4)', () => {
  it('a prefix-scoped transform throws', () => {
    expect(compile(transform([{ startsWith: '/repos/' }]))).toThrow(/path prefix/)
    expect(compile(transform([{ startsWith: '/repos/', methods: ['GET'] }]))).toThrow(/path prefix/)
  })

  it('a `/` prefix with any write method throws; so does a method-only scope that compiles to `/`', () => {
    expect(compile(transform([{ startsWith: '/', methods: ['POST'] }]))).toThrow(/path prefix/)
    expect(compile(transform([{ startsWith: '/', methods: ['GET', 'POST'] }]))).toThrow(/path prefix/)
    expect(compile(transform([{ startsWith: '/' }]))).toThrow(/path prefix/)
    expect(compile(transform([{ methods: ['PUT'] }]))).toThrow(/path prefix/)
  })

  it('the reads-only rule, exact paths and unscoped transforms compile', () => {
    expect(compile(transform([{ startsWith: '/', methods: ['GET', 'HEAD'] }]))).not.toThrow()
    expect(compile(transform([{ startsWith: '/', methods: ['GET'] }]))).not.toThrow()
    expect(compile(transform([{ exact: '/backend-api/codex/responses', methods: ['POST'] }]))).not.toThrow()
    expect(compile(transform(undefined))).not.toThrow()
  })
})
