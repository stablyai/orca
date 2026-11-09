/** Trust vectors measured with OpenSSH10.2p1, ssh-keygen -H and a real sshd, independently of this implementation. */
import { describe, expect, it } from 'vitest'
import {
  matchKnownHosts,
  parseKnownHosts,
  parseKnownHostsLine,
  readHostKeyType
} from './ssh-known-hosts'

const ED_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
const ED_B = 'AAAAC3NzaC1lZDI1NTE5AAAAILu7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7'
const RSA_A =
  'AAAAB3NzaC1yc2EAAABAzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzA=='

/** `ssh-keygen -H` output; the salt/hash pair is real, not synthesised here. */
const HASHED_EXAMPLE_COM = '|1|qvIayk/BTpSrSmc/i3iM4cyYx+8=|6ysCq72Bg48mNavekN+FLrdPc/I='
const HASHED_EXAMPLE_COM_2222 = '|1|qsCyiGgRmqnaNrHKZUgVKG57bnQ=|12y3NTllwASTDOM0EVoQZiVgg9U='

const blob = (base64: string): Buffer => Buffer.from(base64, 'base64')
const line = (hosts: string, key: string, type = 'ssh-ed25519'): string => `${hosts} ${type} ${key}`

type Query = { host?: string; port?: number; key: string }

function verdict(contents: string, query: Query): string {
  return matchKnownHosts(parseKnownHosts(contents), {
    host: query.host ?? 'example.com',
    port: query.port ?? 22,
    keyType: readHostKeyType(blob(query.key)) ?? '',
    key: blob(query.key)
  })
}

describe('matching a presented key', () => {
  describe('ports', () => {
    it('lets the bracketed pass decide when both forms exist', () => {
      const contents = `${line('[example.com]:2222', ED_B)}\n${line('example.com', ED_A)}`
      expect(verdict(contents, { port: 2222, key: ED_A })).toBe('mismatch')
    })
  })

  describe('patterns', () => {
    it('lets one negation veto the whole line', () => {
      const contents = line('*.example.com,!secret.example.com', ED_A)
      expect(verdict(contents, { host: 'secret.example.com', key: ED_A })).toBe('unknown')
      expect(verdict(contents, { host: 'public.example.com', key: ED_A })).toBe('match')
    })
  })

  describe('hashed entries', () => {
    it('matches a hashed host', () => {
      expect(verdict(`${HASHED_EXAMPLE_COM} ssh-ed25519 ${ED_A}`, { key: ED_A })).toBe('match')
    })

    it('reports a change against a hashed host', () => {
      expect(verdict(`${HASHED_EXAMPLE_COM} ssh-ed25519 ${ED_A}`, { key: ED_B })).toBe('mismatch')
    })

    it('does not match a different host', () => {
      const contents = `${HASHED_EXAMPLE_COM} ssh-ed25519 ${ED_A}`
      expect(verdict(contents, { host: 'other.com', key: ED_A })).toBe('unknown')
    })

    it('matches a hashed bracketed entry on its port', () => {
      const contents = `${HASHED_EXAMPLE_COM_2222} ssh-ed25519 ${ED_A}`
      expect(verdict(contents, { port: 2222, key: ED_A })).toBe('match')
    })
  })

  describe('markers', () => {
    const revoked = `@revoked ${line('example.com', ED_A)}`

    it.each([
      ['listed after the good line', `${line('example.com', ED_A)}\n${revoked}`],
      ['listed before it', `${revoked}\n${line('example.com', ED_A)}`]
    ])('reports revoked when %s', (_label, contents) => {
      expect(verdict(contents, { key: ED_A })).toBe('revoked')
    })

    it('treats a cert-authority-only host as unsupported rather than first contact', () => {
      const contents = `@cert-authority ${line('*.example.com', ED_A)}`
      expect(verdict(contents, { host: 'host.example.com', key: ED_B })).toBe('ca-only')
    })

    it('lets a plain line decide alongside a cert-authority line', () => {
      const contents = `@cert-authority ${line('*.example.com', ED_A)}\n${line('host.example.com', ED_B)}`
      expect(verdict(contents, { host: 'host.example.com', key: ED_B })).toBe('match')
    })
  })
})

/** Captured real-client verdicts against a local sshd supplement synthetic expectations. */
// Measured HostKeyAlias always uses bare alias, even on a non-default port.
describe('a lookup keyed on HostKeyAlias', () => {
  // Stale bracketed aliases must not suppress the real bare lookup.
  it('ignores a stale bracketed entry that ssh would never consult', () => {
    const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAIKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
    const ED_OTHER = 'AAAAC3NzaC1lZDI1NTE5AAAAILu7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7'
    const entries = parseKnownHosts(`${line('[myalias]:2225', ED_OTHER)}\n${line('myalias', ED)}`)
    expect(
      matchKnownHosts(entries, {
        host: 'myalias',
        port: 2225,
        keyType: 'ssh-ed25519',
        key: blob(ED),
        isHostKeyAlias: true
      })
    ).toBe('match')
  })
})

describe('lines ssh itself refuses to parse', () => {
  const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAIKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'

  // Buffer.from ignores junk that measured OpenSSH10.2p1 rejects; those lines cannot confer trust.
  it.each([
    ['trailing junk', `${ED}!!!`],
    ['invalid characters spliced into the middle', ED.replace(/^(.{20})/, '$1@@')]
  ])('drops a key field with %s, as ssh does', (_label, keyField) => {
    expect(parseKnownHostsLine(`example.com ssh-ed25519 ${keyField}`)).toBeUndefined()
  })

  // Valid base64/type headers can still carry trailing wire bytes; OpenSSH drops the malformed key.
  it('drops a key blob with trailing bytes its own structure does not account for', () => {
    expect(parseKnownHostsLine(`example.com ssh-ed25519 ${ED}AAAA`)).toBeUndefined()
  })

  it('drops a key blob whose own length prefix overruns the buffer', () => {
    const overrun = Buffer.concat([
      Buffer.from([0, 0, 0, 11]),
      Buffer.from('ssh-ed25519'),
      Buffer.from([0, 0, 0, 99])
    ])
    expect(
      parseKnownHostsLine(`example.com ssh-ed25519 ${overrun.toString('base64')}`)
    ).toBeUndefined()
  })

  // OpenSSH requires20-byte SHA1 salts; shorter HMAC-compatible values cannot grant trust.
  it('drops a hashed entry whose salt is not a full SHA1 digest', () => {
    const shortSalt = Buffer.alloc(16, 1).toString('base64')
    const hash = Buffer.alloc(20, 2).toString('base64')
    expect(parseKnownHostsLine(`|1|${shortSalt}|${hash} ssh-ed25519 ${ED}`)).toBeUndefined()
  })

  const [, , REAL_SALT = '', REAL_HASH = ''] = HASHED_EXAMPLE_COM.split('|')
  const hashedLine = (salt: string, hash: string): string => `|1|${salt}|${hash} ssh-ed25519 ${ED}`

  // All mutations still decode to20 bytes; OpenSSH rejects noncanonical encodings despite permissive Buffer.from.
  it.each([
    ['salt with invalid characters spliced into the middle', REAL_SALT.replace(/^(.{6})/, '$1@@')],
    ['salt with trailing junk', `${REAL_SALT}!!!`],
    // Buffer.from accepts the base64url alphabet and yields the same 20 bytes; ssh does not.
    ['salt in the base64url alphabet', REAL_SALT.replace(/\//g, '_').replace(/\+/g, '-')],
    // Correct length with nonzero leftover bits is still noncanonical and rejected by b64_pton.
    ['salt whose final character carries non-zero padding bits', `${REAL_SALT.slice(0, -2)}9=`],
    ['salt with its base64 padding stripped', REAL_SALT.replace(/=+$/, '')]
  ])('drops a hashed entry with a %s, as ssh does', (_label, salt) => {
    expect(parseKnownHostsLine(hashedLine(salt, REAL_HASH))).toBeUndefined()
  })

  it.each([
    ['invalid characters spliced into the middle', REAL_HASH.replace(/^(.{6})/, '$1@@')],
    ['trailing junk', `${REAL_HASH}!!!`]
  ])('drops a hashed entry whose hash has %s, as ssh does', (_label, hash) => {
    expect(parseKnownHostsLine(hashedLine(REAL_SALT, hash))).toBeUndefined()
  })

  // Extra padding is a b64_pton error too, so the key field is held to the same exact-encoding rule.
  it('drops a key field with extra base64 padding', () => {
    expect(parseKnownHostsLine(`example.com ssh-ed25519 ${ED}==`)).toBeUndefined()
  })

  // The parse result IS the trust decision: a junk-salt line previously produced a full `match`.
  it('reports unknown for a junk-salt hashed line instead of matching it', () => {
    expect(verdict(hashedLine(REAL_SALT.replace(/^(.{6})/, '$1@@'), REAL_HASH), { key: ED })).toBe(
      'unknown'
    )
    expect(verdict(hashedLine(REAL_SALT, REAL_HASH), { key: ED })).toBe('match')
  })
})

describe('agreement with a live OpenSSH client', () => {
  const SERVER_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIM2eSSqUqU9LERdg8qNjFiU59unM+JyfwFHLkMxR13oq'
  const OTHER_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIKmVZ4Z+MJ3VYnZmZmZmZmZmZmZmZmZmZmZmZmZmZmZm'

  // Real ssh-keygen -H output hashes the bracketed endpoint, not the bare host.
  const HASHED_BRACKETED_ENTRY = `|1|nfzVRh+YQtj+wIqjDBYLW2cryfQ=|Q51GJuiWfUGYpAPuRPyFC/FpKj4= ssh-ed25519 ${SERVER_KEY}`

  it('accepts the hashed bracketed entry ssh-keygen -H produced, as ssh did', () => {
    expect(
      verdict(HASHED_BRACKETED_ENTRY, { host: '127.0.0.1', port: 2222, key: SERVER_KEY })
    ).toBe('match')
  })

  // Measured off-port RSA evidence blocks bare correct-ed25519 fallback and refuses as changed; continuing would accept an endpoint SSH rejects.
  it('does not fall back past an off-port entry of another type, as ssh did not', () => {
    const contents = `${line('[127.0.0.1]:2223', RSA_A, 'ssh-rsa')}\n${line('127.0.0.1', SERVER_KEY)}`
    expect(verdict(contents, { host: '127.0.0.1', port: 2223, key: SERVER_KEY })).toBe(
      'unknown-type-known-host'
    )
  })

  // Measured bare-only other-type evidence is first contact off-port.
  it('treats an other-type entry found only on the fallback pass as unknown, as ssh did', () => {
    expect(
      verdict(line('127.0.0.1', RSA_A, 'ssh-rsa'), {
        host: '127.0.0.1',
        port: 2223,
        key: SERVER_KEY
      })
    ).toBe('unknown')
  })

  // Measured wrong bare fallback keys are first contact; strict accept-new appends the port-qualified key.
  it('reports a wrong key on the bare fallback line as unknown, as ssh did', () => {
    expect(
      verdict(line('127.0.0.1', OTHER_KEY), { host: '127.0.0.1', port: 2222, key: SERVER_KEY })
    ).toBe('unknown')
  })

  it('reports a wrong key on the exact bracketed line as a change, as ssh did', () => {
    expect(
      verdict(line('[127.0.0.1]:2222', OTHER_KEY), {
        host: '127.0.0.1',
        port: 2222,
        key: SERVER_KEY
      })
    ).toBe('mismatch')
  })
})
