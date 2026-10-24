/**
 * Vectors verified against OpenSSH 10.2p1 — `ssh-keygen -H` for the hashed entries and a throwaway
 * sshd with `-v` for the verdicts — rather than derived from this implementation. That matters:
 * a parser test written from its own parser passes by construction.
 */
import { describe, expect, it } from 'vitest'
import {
  hostCandidatePasses,
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

describe('known_hosts parsing', () => {
  it('reads the algorithm from the blob rather than trusting the line', () => {
    expect(readHostKeyType(blob(ED_A))).toBe('ssh-ed25519')
    expect(readHostKeyType(blob(RSA_A))).toBe('ssh-rsa')
  })

  it.each([
    ['blank', '   '],
    ['comment', '# a comment'],
    ['too few fields', 'example.com ssh-ed25519'],
    ['unrecognised marker', `@bogus ${line('example.com', ED_A)}`],
    ['type field disagreeing with the blob', `example.com ssh-rsa ${ED_A}`],
    ['empty salt', `|1||6ysCq72Bg48mNavekN+FLrdPc/I= ssh-ed25519 ${ED_A}`],
    ['hash that is not 20 bytes', `|1|qvIayk/BTpSrSmc/i3iM4cyYx+8=|AAAA ssh-ed25519 ${ED_A}`],
    ['wrong hashed field count', `|1|a|b|c ssh-ed25519 ${ED_A}`],
    ['undecodable key', 'example.com ssh-ed25519 !!!not-base64!!!']
  ])('rejects %s', (_label, raw) => {
    expect(parseKnownHostsLine(raw)).toBeUndefined()
  })

  it.each([
    ['empty buffer', Buffer.alloc(0)],
    ['truncated length prefix', Buffer.alloc(2)],
    ['length running past the end', Buffer.from([0, 0, 0xff, 0xff, 1, 2, 3, 4])],
    ['zero length', Buffer.from([0, 0, 0, 0, 1, 2, 3, 4])]
  ])('refuses a malformed blob: %s', (_label, buffer) => {
    expect(readHostKeyType(buffer)).toBeUndefined()
  })
})

describe('candidate passes', () => {
  it('uses the bare host on the default port', () => {
    expect(hostCandidatePasses('Example.com', 22)).toEqual([['example.com']])
  })

  // OpenSSH logs "checking without port identifier" — the bare form is a real second pass.
  it('tries the bracketed form first and falls back to bare off-port', () => {
    expect(hostCandidatePasses('example.com', 2222)).toEqual([
      ['[example.com]:2222'],
      ['example.com']
    ])
  })
})

describe('matching a presented key', () => {
  it('matches an exact line', () => {
    expect(verdict(line('example.com', ED_A), { key: ED_A })).toBe('match')
  })

  it('matches case-insensitively', () => {
    expect(verdict(line('example.com', ED_A), { host: 'EXAMPLE.COM', key: ED_A })).toBe('match')
  })

  it('reports a changed key of the same type', () => {
    expect(verdict(line('example.com', ED_A), { key: ED_B })).toBe('mismatch')
  })

  it.each([
    ['another host', line('example.com', ED_A), 'other.com'],
    ['an empty file', '', 'example.com']
  ])('reports unknown for %s', (_label, contents, host) => {
    expect(verdict(contents, { host, key: ED_A })).toBe('unknown')
  })

  it('matches any host in a comma list', () => {
    const contents = line('a.example.com,b.example.com,1.2.3.4', ED_A)
    expect(verdict(contents, { host: 'b.example.com', key: ED_A })).toBe('match')
  })

  describe('ports', () => {
    it('matches the bracketed form on its port', () => {
      expect(verdict(line('[example.com]:2222', ED_A), { port: 2222, key: ED_A })).toBe('match')
    })

    it('does not apply a bracketed entry to the default port', () => {
      expect(verdict(line('[example.com]:2222', ED_A), { key: ED_A })).toBe('unknown')
    })

    it('falls back to a bare line when off-port', () => {
      expect(verdict(line('example.com', ED_A), { port: 2222, key: ED_A })).toBe('match')
    })

    // The fallback pass is advisory: OpenSSH downgrades a wrong key there to "not known".
    it('never reports a change from the fallback pass', () => {
      expect(verdict(line('example.com', ED_B), { port: 2222, key: ED_A })).toBe('unknown')
    })

    it('lets the bracketed pass decide when both forms exist', () => {
      const contents = `${line('[example.com]:2222', ED_B)}\n${line('example.com', ED_A)}`
      expect(verdict(contents, { port: 2222, key: ED_A })).toBe('mismatch')
    })
  })

  // The design moved IPv6 into scope: a literal that comes back `unknown` because we mangled the
  // brackets is prompt-training, the harm the whole outcome vocabulary exists to avoid.
  describe('IPv6 literals', () => {
    it('matches a bare literal on the default port', () => {
      const contents = line('2001:db8::1', ED_A)
      expect(verdict(contents, { host: '2001:db8::1', key: ED_A })).toBe('match')
    })

    it('matches a bracketed literal on its port', () => {
      const contents = line('[2001:db8::1]:2222', ED_A)
      expect(verdict(contents, { host: '2001:db8::1', port: 2222, key: ED_A })).toBe('match')
    })

    it('reports a change for a literal', () => {
      const contents = line('2001:db8::1', ED_A)
      expect(verdict(contents, { host: '2001:db8::1', key: ED_B })).toBe('mismatch')
    })
  })

  describe('patterns', () => {
    it.each([
      ['a star glob', line('*.example.com', ED_A), 'host.example.com', 'match'],
      ['a non-matching glob', line('*.example.com', ED_A), 'host.other.com', 'unknown'],
      ['a question-mark glob', line('host?.example.com', ED_A), 'host1.example.com', 'match']
    ])('handles %s', (_label, contents, host, expected) => {
      expect(verdict(contents, { host, key: ED_A })).toBe(expected)
    })

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

    // The bracketed string itself is hashed, so each candidate form must be hashed separately.
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

    it('still reports a change for a different key on a revoked host', () => {
      expect(verdict(`${line('example.com', ED_A)}\n${revoked}`, { key: ED_B })).toBe('mismatch')
    })

    it('treats a cert-authority-only host as unsupported rather than first contact', () => {
      const contents = `@cert-authority ${line('*.example.com', ED_A)}`
      expect(verdict(contents, { host: 'host.example.com', key: ED_B })).toBe('ca-only')
    })

    it('lets a plain line decide alongside a cert-authority line', () => {
      const contents = `@cert-authority ${line('*.example.com', ED_A)}\n${line('host.example.com', ED_B)}`
      expect(verdict(contents, { host: 'host.example.com', key: ED_B })).toBe('match')
    })

    it('skips a line carrying an unrecognised marker', () => {
      expect(verdict(`@bogus ${line('example.com', ED_A)}`, { key: ED_A })).toBe('unknown')
    })
  })

  describe('key types', () => {
    // The distinction the whole design rests on: a host we know by another type is NOT first
    // contact, or an attacker who cannot forge the known type just presents a different one.
    it('does not report a change when only another key type is on file', () => {
      const contents = line('example.com', RSA_A, 'ssh-rsa')
      expect(verdict(contents, { key: ED_A })).toBe('unknown-type-known-host')
    })

    it('matches within the same type', () => {
      const contents = line('example.com', RSA_A, 'ssh-rsa')
      expect(verdict(contents, { key: RSA_A })).toBe('match')
    })
  })

  describe('file shape', () => {
    it('accepts CRLF terminators', () => {
      expect(verdict(`${line('example.com', ED_A)}\r\n`, { key: ED_A })).toBe('match')
    })

    it('skips blanks, comments and surrounding whitespace', () => {
      const contents = `\n# comment\n   \n   ${line('example.com', ED_A)}   \n`
      expect(verdict(contents, { key: ED_A })).toBe('match')
    })

    // Files are unioned by the caller: any exact hit wins, and disagreement elsewhere is not a
    // change. Both orderings verified live.
    it.each([
      ['user file first', `${line('h', ED_A)}\n${line('h', ED_B)}`],
      ['global file first', `${line('h', ED_B)}\n${line('h', ED_A)}`]
    ])('accepts a hit regardless of which file holds it (%s)', (_label, contents) => {
      expect(verdict(contents, { host: 'h', key: ED_A })).toBe('match')
    })
  })
})

/**
 * Vectors produced by a real OpenSSH 10.2p1 client against a real sshd on 127.0.0.1:2222, with the
 * client's verdict recorded from its own output. Everything else in this file states what we believe
 * ssh does; these state what it did.
 */
// HostKeyAlias is the one case where the port is not part of the key. Verified live on port 2225:
// with HostKeyAlias=myalias, ssh finds an entry keyed `myalias` and reports "No ED25519 host key is
// known for myalias" for one keyed `[myalias]:2225`.
describe('a lookup keyed on HostKeyAlias', () => {
  it('never brackets the alias, whatever the port', () => {
    expect(hostCandidatePasses('myalias', 2225, true)).toEqual([['myalias']])
  })

  it('still brackets an ordinary host on a non-default port', () => {
    expect(hostCandidatePasses('h', 2225, false)).toEqual([['[h]:2225'], ['h']])
  })

  it('matches a bare alias entry on a non-default port', () => {
    const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAIKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
    const entries = parseKnownHosts(line('myalias', ED))
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

  // The regression the flag prevents: pass 0 finding a bracketed entry now stops the fallback, so
  // without it this stale line turns a working bastion into a hard failure.
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

  // Buffer.from SKIPS invalid base64 characters instead of failing, so each of these decodes to
  // something. Verified live against OpenSSH 10.2p1 on 127.0.0.1:2224: the valid control reached
  // authentication and ALL THREE of these produced "No ED25519 host key is known" — ssh drops the
  // line. Honouring them means granting trust from a line the user's own ssh ignores, and for the
  // padded variant it means raising a CHANGED alarm from one.
  it.each([
    ['trailing junk', `${ED}!!!`],
    ['invalid characters spliced into the middle', ED.replace(/^(.{20})/, '$1@@')]
  ])('drops a key field with %s, as ssh does', (_label, keyField) => {
    expect(parseKnownHostsLine(`example.com ssh-ed25519 ${keyField}`)).toBeUndefined()
  })

  // Still VALID base64 — 68 characters plus 4 is a legal length — and the algorithm header still
  // reads ssh-ed25519, so neither the base64 check nor the header check catches it. ssh parses the
  // whole key structure and drops the line; we decoded 54 bytes where the key is 51 and reported a
  // CHANGED alarm from an entry ssh ignores.
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

  it('still accepts the unmodified key field', () => {
    expect(parseKnownHostsLine(`example.com ssh-ed25519 ${ED}`)).toBeDefined()
  })

  // ssh's extract_salt demands exactly one SHA1 digest: "expected salt len 20, got 16". A shorter
  // salt is still a usable HMAC key for us, so we could match a hand-crafted line that is invisible
  // to the user's ssh. ssh-keygen -H always writes 20 bytes, so refusing loses no real entry.
  it('drops a hashed entry whose salt is not a full SHA1 digest', () => {
    const shortSalt = Buffer.alloc(16, 1).toString('base64')
    const hash = Buffer.alloc(20, 2).toString('base64')
    expect(parseKnownHostsLine(`|1|${shortSalt}|${hash} ssh-ed25519 ${ED}`)).toBeUndefined()
  })

  it('accepts a hashed entry whose salt is a full SHA1 digest', () => {
    const salt = Buffer.alloc(20, 1).toString('base64')
    const hash = Buffer.alloc(20, 2).toString('base64')
    expect(parseKnownHostsLine(`|1|${salt}|${hash} ssh-ed25519 ${ED}`)).toBeDefined()
  })

  const [, , REAL_SALT = '', REAL_HASH = ''] = HASHED_EXAMPLE_COM.split('|')
  const hashedLine = (salt: string, hash: string): string => `|1|${salt}|${hash} ssh-ed25519 ${ED}`

  // Non-obvious: every mutation below still decodes to exactly 20 bytes, so the length check above
  // passes and the entry would be trusted — Buffer.from just skips the junk. Verified live against
  // OpenSSH 10.2p1 with `ssh-keygen -vvv -F` on a real `ssh-keygen -H` file: the salt cases print
  // "extract_salt: salt decode error" / "bad host hash", and the hash cases find nothing silently
  // because ssh regenerates the canonical `|1|salt|hash` string and byte-compares it.
  it.each([
    ['salt with invalid characters spliced into the middle', REAL_SALT.replace(/^(.{6})/, '$1@@')],
    ['salt with trailing junk', `${REAL_SALT}!!!`],
    // Buffer.from accepts the base64url alphabet and yields the same 20 bytes; ssh does not.
    ['salt in the base64url alphabet', REAL_SALT.replace(/\//g, '_').replace(/\+/g, '-')],
    // Right length and it looks like base64, but the final character's leftover bits are set — the
    // case a "does it look like base64" check misses and b64_pton rejects as a subliminal channel.
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

  // Guards the cases above from passing by rejecting everything.
  it('still accepts the unmutated ssh-keygen -H vector', () => {
    expect(parseKnownHostsLine(hashedLine(REAL_SALT, REAL_HASH))).toBeDefined()
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

  // `ssh-keygen -H` on `[127.0.0.1]:2222 ssh-ed25519 <SERVER_KEY>`. The salt and hash are its own
  // output, so this pins that we hash the BRACKETED candidate — hashing the bare host would miss.
  const HASHED_BRACKETED_ENTRY = `|1|nfzVRh+YQtj+wIqjDBYLW2cryfQ=|Q51GJuiWfUGYpAPuRPyFC/FpKj4= ssh-ed25519 ${SERVER_KEY}`

  it('accepts the hashed bracketed entry ssh-keygen -H produced, as ssh did', () => {
    expect(
      verdict(HASHED_BRACKETED_ENTRY, { host: '127.0.0.1', port: 2222, key: SERVER_KEY })
    ).toBe('match')
  })

  // THE accept-a-changed-key case. Live on 127.0.0.1:2223 against an ed25519-only server, with an
  // off-port RSA entry AND a bare correct ed25519 line, ssh printed IDENTIFICATION HAS CHANGED and
  // refused — and printed NO "checking without port identifier", so the fallback never ran. ssh
  // gates that pass on the port-qualified lookup matching no plain entry of ANY type; gating it on
  // "no match and no same-type mismatch" instead reaches the bare line and returns `match`.
  it('does not fall back past an off-port entry of another type, as ssh did not', () => {
    const contents = `${line('[127.0.0.1]:2223', RSA_A, 'ssh-rsa')}\n${line('127.0.0.1', SERVER_KEY)}`
    expect(verdict(contents, { host: '127.0.0.1', port: 2223, key: SERVER_KEY })).toBe(
      'unknown-type-known-host'
    )
  })

  // The same flags, the opposite error. Live, a BARE ssh-rsa entry dialed on 2223 against the same
  // ed25519-only server made ssh add the host and connect — plain first contact. Letting the
  // fallback pass set unknown-type-known-host refuses a host ssh accepts.
  it('treats an other-type entry found only on the fallback pass as unknown, as ssh did', () => {
    expect(
      verdict(line('127.0.0.1', RSA_A, 'ssh-rsa'), {
        host: '127.0.0.1',
        port: 2223,
        key: SERVER_KEY
      })
    ).toBe('unknown')
  })

  // Live: ssh reached authentication, so it accepted the bare line for a non-default port.
  it('falls back to the bare host line on a non-default port, as ssh did', () => {
    expect(
      verdict(line('127.0.0.1', SERVER_KEY), { host: '127.0.0.1', port: 2222, key: SERVER_KEY })
    ).toBe('match')
  })

  // THE one that decides whether the fallback pass may report a change. Live, with
  // StrictHostKeyChecking=accept-new and a bare line holding a DIFFERENT key, ssh connected and
  // appended a new `[127.0.0.1]:2222` line — so it read this as first contact, not as a changed
  // key, and printed no IDENTIFICATION HAS CHANGED banner. Reporting `mismatch` here would refuse a
  // host ssh connects to happily.
  it('reports a wrong key on the bare fallback line as unknown, as ssh did', () => {
    expect(
      verdict(line('127.0.0.1', OTHER_KEY), { host: '127.0.0.1', port: 2222, key: SERVER_KEY })
    ).toBe('unknown')
  })

  // Same file shape, but the entry is for the exact endpoint: live, ssh printed
  // IDENTIFICATION HAS CHANGED and refused.
  it('reports a wrong key on the exact bracketed line as a change, as ssh did', () => {
    expect(
      verdict(line('[127.0.0.1]:2222', OTHER_KEY), {
        host: '127.0.0.1',
        port: 2222,
        key: SERVER_KEY
      })
    ).toBe('mismatch')
  })

  // Live: known_hosts held an ssh-rsa key for the endpoint and the server offered ed25519 — ssh
  // printed IDENTIFICATION HAS CHANGED and refused. So our unknown-type-known-host rejection is
  // neither stricter nor laxer than ssh; treating it as first contact would have been laxer.
  it('refuses a key type it has not seen for a host it knows, as ssh did', () => {
    expect(
      verdict(line('[127.0.0.1]:2222', RSA_A, 'ssh-rsa'), {
        host: '127.0.0.1',
        port: 2222,
        key: SERVER_KEY
      })
    ).toBe('unknown-type-known-host')
  })
})
