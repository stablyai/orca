import { rm } from 'node:fs/promises'
import 'node:os'
import 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isOpenSshSecurityKeyPrivateKey,
  isOpenSshSecurityKeyPublicKey
} from './ssh-security-key-identity'
import {
  createOpenSshPrivateKeyFixture,
  createOpenSshPublicKeyFixture
} from './ssh-security-key-identity.test-fixture'
import './ssh-transport-selection'

const { findSystemSshMock } = vi.hoisted(() => ({ findSystemSshMock: vi.fn() }))

vi.mock('./system-transport/system-ssh-binary', () => ({ findSystemSsh: findSystemSshMock }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<{ homedir: () => string }>()
  return {
    ...actual,
    homedir: () => process.env.ORCA_TEST_SSH_HOME || actual.homedir()
  }
})

const ED25519_SECURITY_KEY = 'sk-ssh-ed25519@openssh.com'
const ECDSA_SECURITY_KEY = 'sk-ecdsa-sha2-nistp256@openssh.com'
const tempDirs: string[] = []

beforeEach(() => {
  findSystemSshMock.mockReset()
  findSystemSshMock.mockReturnValue('/usr/bin/ssh')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('isOpenSshSecurityKeyPrivateKey', () => {
  it.each([ED25519_SECURITY_KEY, ECDSA_SECURITY_KEY])(
    'recognizes unencrypted %s keys',
    (keyType) => {
      expect(isOpenSshSecurityKeyPrivateKey(createOpenSshPrivateKeyFixture([keyType]))).toBe(true)
    }
  )

  it('does not match security-key text outside a valid public-key type', () => {
    const key = createOpenSshPrivateKeyFixture(['ssh-ed25519'], {
      privateBlock: Buffer.from(ED25519_SECURITY_KEY)
    })
    expect(isOpenSshSecurityKeyPrivateKey(key)).toBe(false)
    expect(
      isOpenSshSecurityKeyPrivateKey(Buffer.from(`${ED25519_SECURITY_KEY} AAAA comment`))
    ).toBe(false)
  })

  it('rejects regular or mismatched OpenSSH public key blobs', () => {
    expect(isOpenSshSecurityKeyPublicKey(createOpenSshPublicKeyFixture('ssh-ed25519'))).toBe(false)
    expect(
      isOpenSshSecurityKeyPublicKey(
        Buffer.from(`${ED25519_SECURITY_KEY} ${Buffer.from('ssh-ed25519').toString('base64')}`)
      )
    ).toBe(false)
  })

  it('rejects malformed and truncated OpenSSH envelopes without throwing', () => {
    const key = createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY])
    const malformedLength = Buffer.concat([
      Buffer.from('openssh-key-v1\0', 'ascii'),
      Buffer.from([0xff, 0xff, 0xff, 0xff])
    ]).toString('base64')
    const malformedKey = Buffer.from(
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${malformedLength}\n-----END OPENSSH PRIVATE KEY-----\n`
    )
    expect(isOpenSshSecurityKeyPrivateKey(key.subarray(0, -20))).toBe(false)
    expect(isOpenSshSecurityKeyPrivateKey(malformedKey)).toBe(false)
    expect(isOpenSshSecurityKeyPrivateKey(Buffer.from('not a private key'))).toBe(false)
  })
})
