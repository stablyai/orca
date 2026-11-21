/** Trust vectors measured with OpenSSH10.2p1, ssh-keygen -H and a real sshd, independently of this implementation. */
import { describe, expect, it } from 'vitest'
import { matchKnownHosts, parseKnownHosts, readHostKeyType } from './ssh-known-hosts'

const RSA_A =
  'AAAAB3NzaC1yc2EAAABAzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzA=='

/** `ssh-keygen -H` output; the salt/hash pair is real, not synthesised here. */
const HASHED_EXAMPLE_COM = '|1|qvIayk/BTpSrSmc/i3iM4cyYx+8=|6ysCq72Bg48mNavekN+FLrdPc/I='

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

describe('lines ssh itself refuses to parse', () => {
  const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAIKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'

  const [, , REAL_SALT = '', REAL_HASH = ''] = HASHED_EXAMPLE_COM.split('|')
  const hashedLine = (salt: string, hash: string): string => `|1|${salt}|${hash} ssh-ed25519 ${ED}`

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

  // Measured off-port RSA evidence blocks bare correct-ed25519 fallback and refuses as changed; continuing would accept an endpoint SSH rejects.
  it('does not fall back past an off-port entry of another type, as ssh did not', () => {
    const contents = `${line('[127.0.0.1]:2223', RSA_A, 'ssh-rsa')}\n${line('127.0.0.1', SERVER_KEY)}`
    expect(verdict(contents, { host: '127.0.0.1', port: 2223, key: SERVER_KEY })).toBe(
      'unknown-type-known-host'
    )
  })
})
