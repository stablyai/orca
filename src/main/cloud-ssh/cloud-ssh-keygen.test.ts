import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOSTED_SANDBOX_SSH_PUBLIC_KEY } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import { encodeOpenSshKeyPair, generateCloudSshKeyPair } from './cloud-ssh-keygen'

const hasSshKeygen = spawnSync('ssh-keygen', ['-?']).error === undefined
let dir: string | null = null

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = null
  }
})

describe('generateCloudSshKeyPair', () => {
  it('makes a public key line the control plane accepts', () => {
    const pair = generateCloudSshKeyPair('orca:mac-studio:orca-fix-login-1a2b')
    expect(pair.publicKey).toMatch(HOSTED_SANDBOX_SSH_PUBLIC_KEY)
    expect(pair.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')).toBe(true)
    expect(pair.privateKey.trimEnd().endsWith('-----END OPENSSH PRIVATE KEY-----')).toBe(true)
  })

  it('makes a fresh key every time', () => {
    expect(generateCloudSshKeyPair('a:b:c').publicKey).not.toBe(
      generateCloudSshKeyPair('a:b:c').publicKey
    )
  })

  it.runIf(hasSshKeygen)('writes a private key OpenSSH reads back to the same public key', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-cloud-ssh-'))
    const pair = generateCloudSshKeyPair('orca:test:orca-ws-0001')
    const file = join(dir, 'id')
    writeFileSync(file, pair.privateKey, { mode: 0o600 })
    const derived = execFileSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8' }).trim()
    expect(derived.split(' ').slice(0, 2)).toEqual(pair.publicKey.split(' ').slice(0, 2))
  })

  it('pads the private section to the cipher block size', () => {
    const pair = encodeOpenSshKeyPair(Buffer.alloc(32, 1), Buffer.alloc(32, 2), 'x')
    const body = Buffer.from(
      pair.privateKey
        .split('\n')
        .filter((line) => !line.startsWith('-----'))
        .join(''),
      'base64'
    )
    expect(body.subarray(0, 15).toString('binary')).toBe('openssh-key-v1\0')
    // Walk cipher, kdf, kdf options, key count and public key to reach the private section.
    let offset = 15
    const field = (): Buffer => {
      const length = body.readUInt32BE(offset)
      const value = body.subarray(offset + 4, offset + 4 + length)
      offset += 4 + length
      return value
    }
    expect(field().toString()).toBe('none')
    expect(field().toString()).toBe('none')
    expect(field().length).toBe(0)
    expect(body.readUInt32BE(offset)).toBe(1)
    offset += 4
    field()
    const section = field()
    expect(offset).toBe(body.length)
    expect(section.length % 8).toBe(0)
    // The two check words match, as OpenSSH requires to accept the key.
    expect(section.readUInt32BE(0)).toBe(section.readUInt32BE(4))
  })
})
