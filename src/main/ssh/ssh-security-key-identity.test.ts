import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import {
  isOpenSshSecurityKeyPrivateKey,
  isOpenSshSecurityKeyPublicKey
} from './ssh-security-key-identity'
import {
  createOpenSshPrivateKeyFixture,
  createOpenSshPublicKeyFixture
} from './ssh-security-key-identity.test-fixture'
import { requiresSystemSshForSecurityKey } from './ssh-transport-selection'

const { findSystemSshMock } = vi.hoisted(() => ({ findSystemSshMock: vi.fn() }))

vi.mock('./system-ssh-binary', () => ({ findSystemSsh: findSystemSshMock }))

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

function createTarget(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'target-1',
    label: 'Test Server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    ...overrides
  }
}

beforeEach(() => {
  findSystemSshMock.mockReset()
  findSystemSshMock.mockReturnValue('/usr/bin/ssh')
})

async function writeKey(contents: Buffer, filename = 'security key'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-security-key-'))
  tempDirs.push(directory)
  const keyPath = join(directory, filename)
  await writeFile(keyPath, contents)
  return keyPath
}

async function createDefaultKeyHome(files: Record<string, Buffer>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-default-key-home-'))
  tempDirs.push(directory)
  await mkdir(join(directory, '.ssh'))
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, '.ssh', name), contents)
  }
  return directory
}

// Why: `ssh -G` echoes this list, already home-expanded, for every host — configured or not.
function listBuiltInDefaultIdentityFiles(home: string): string[] {
  return [
    'id_rsa',
    'id_ecdsa',
    'id_ecdsa_sk',
    'id_ed25519',
    'id_ed25519_sk',
    'id_xmss',
    'id_dsa'
  ].map((name) => join(home, '.ssh', name))
}

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

  it('recognizes authenticated encrypted envelopes with a trailing tag', () => {
    const key = createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY], {
      cipher: 'aes256-gcm@openssh.com',
      authTag: Buffer.alloc(16, 7)
    })
    expect(isOpenSshSecurityKeyPrivateKey(key)).toBe(true)
  })

  it.each([ED25519_SECURITY_KEY, ECDSA_SECURITY_KEY])(
    'recognizes encrypted %s keys from the public section',
    (keyType) => {
      const key = createOpenSshPrivateKeyFixture([keyType], { encrypted: true })
      expect(isOpenSshSecurityKeyPrivateKey(key)).toBe(true)
    }
  )

  it.each(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'])(
    'leaves regular %s keys on ssh2',
    (keyType) => {
      expect(isOpenSshSecurityKeyPrivateKey(createOpenSshPrivateKeyFixture([keyType]))).toBe(false)
    }
  )

  it('supports CRLF armored keys', () => {
    const key = createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY])
    expect(
      isOpenSshSecurityKeyPrivateKey(Buffer.from(key.toString().replaceAll('\n', '\r\n')))
    ).toBe(true)
  })

  it('recognizes OpenSSH envelopes without optional base64 padding', () => {
    const key = createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY], {
      privateBlock: Buffer.alloc(0)
    })
    const unpadded = Buffer.from(key.toString().replace(/=+(?=\n-----END)/, ''))
    expect(unpadded).not.toEqual(key)
    expect(isOpenSshSecurityKeyPrivateKey(unpadded)).toBe(true)
  })

  it('does not match security-key text outside a valid public-key type', () => {
    const key = createOpenSshPrivateKeyFixture(['ssh-ed25519'], {
      privateBlock: Buffer.from(ED25519_SECURITY_KEY)
    })
    expect(isOpenSshSecurityKeyPrivateKey(key)).toBe(false)
    expect(
      isOpenSshSecurityKeyPrivateKey(Buffer.from(`${ED25519_SECURITY_KEY} AAAA comment`))
    ).toBe(false)
  })

  it.each([ED25519_SECURITY_KEY, ECDSA_SECURITY_KEY])(
    'validates the %s type inside an OpenSSH public key blob',
    (keyType) => {
      expect(isOpenSshSecurityKeyPublicKey(createOpenSshPublicKeyFixture(keyType))).toBe(true)
    }
  )

  it('recognizes public keys without optional base64 padding', () => {
    const key = createOpenSshPublicKeyFixture(ECDSA_SECURITY_KEY)
    const unpadded = Buffer.from(key.toString().replace(/=+(?=\s)/, ''))
    expect(unpadded).not.toEqual(key)
    expect(isOpenSshSecurityKeyPublicKey(unpadded)).toBe(true)
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

describe('requiresSystemSshForSecurityKey', () => {
  it('uses default FIDO2 identities only when config resolution is unavailable', async () => {
    const directory = await createDefaultKeyHome({
      id_ed25519_sk: createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY])
    })
    vi.stubEnv('ORCA_TEST_SSH_HOME', directory)

    await expect(requiresSystemSshForSecurityKey(createTarget(), null)).resolves.toBe(true)
    await expect(
      requiresSystemSshForSecurityKey(createTarget(), { identityFile: [] })
    ).resolves.toBe(false)
  })

  it('reaches a default FIDO2 identity that a regular default key precedes', async () => {
    const directory = await createDefaultKeyHome({
      id_rsa: createOpenSshPrivateKeyFixture(['ssh-rsa']),
      id_ed25519_sk: createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY])
    })
    vi.stubEnv('ORCA_TEST_SSH_HOME', directory)

    await expect(requiresSystemSshForSecurityKey(createTarget(), null)).resolves.toBe(true)

    findSystemSshMock.mockReturnValue(null)
    await expect(requiresSystemSshForSecurityKey(createTarget(), null)).resolves.toBe(false)
  })

  it('leaves regular-only defaults on ssh2', async () => {
    const directory = await createDefaultKeyHome({
      id_rsa: createOpenSshPrivateKeyFixture(['ssh-rsa'])
    })
    vi.stubEnv('ORCA_TEST_SSH_HOME', directory)

    await expect(requiresSystemSshForSecurityKey(createTarget(), null)).resolves.toBe(false)
  })

  it('treats resolved built-in default identities as unconfigured, not as forced transport', async () => {
    const directory = await createDefaultKeyHome({
      id_rsa: createOpenSshPrivateKeyFixture(['ssh-rsa']),
      id_ed25519_sk: createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY])
    })
    const identityFile = listBuiltInDefaultIdentityFiles(directory)

    await expect(requiresSystemSshForSecurityKey(createTarget(), { identityFile })).resolves.toBe(
      true
    )

    findSystemSshMock.mockReturnValue(null)
    await expect(requiresSystemSshForSecurityKey(createTarget(), { identityFile })).resolves.toBe(
      false
    )
  })

  it('keeps password and agent fallback when a configured FIDO2 identity has no OpenSSH', async () => {
    const keyPath = await writeKey(createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY]))
    findSystemSshMock.mockReturnValue(null)

    await expect(
      requiresSystemSshForSecurityKey(createTarget({ identityFile: keyPath }), null)
    ).resolves.toBe(false)
  })

  it('keeps password and agent fallback when default FIDO2 needs unavailable OpenSSH', async () => {
    const directory = await createDefaultKeyHome({
      id_ed25519_sk: createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY])
    })
    vi.stubEnv('ORCA_TEST_SSH_HOME', directory)
    findSystemSshMock.mockReturnValue(null)

    await expect(requiresSystemSshForSecurityKey(createTarget(), null)).resolves.toBe(false)
  })

  it('ignores an orphan regular sidecar before a valid default FIDO2 identity', async () => {
    const directory = await createDefaultKeyHome({
      'id_ed25519.pub': createOpenSshPublicKeyFixture('ssh-ed25519'),
      id_ed25519_sk: createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY])
    })
    vi.stubEnv('ORCA_TEST_SSH_HOME', directory)

    await expect(requiresSystemSshForSecurityKey(createTarget(), null)).resolves.toBe(true)
  })

  it('detects a manual target identity path with spaces', async () => {
    const keyPath = await writeKey(createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY]))
    await expect(
      requiresSystemSshForSecurityKey(createTarget({ identityFile: keyPath }), null)
    ).resolves.toBe(true)
  })

  it('checks every fresh resolved identity for config-backed targets', async () => {
    const regularKey = await writeKey(createOpenSshPrivateKeyFixture(['ssh-ed25519']), 'regular')
    const securityKey = await writeKey(
      createOpenSshPrivateKeyFixture([ECDSA_SECURITY_KEY], { encrypted: true }),
      'security'
    )
    const target = createTarget({
      source: 'ssh-config',
      configHost: 'workbox',
      identityFile: '/stale/security-key'
    })

    await expect(
      requiresSystemSshForSecurityKey(target, { identityFile: [regularKey, securityKey] })
    ).resolves.toBe(true)
  })

  it.each([ED25519_SECURITY_KEY, ECDSA_SECURITY_KEY])(
    'detects an agent-backed %s identity from its public sidecar',
    async (keyType) => {
      const directory = await mkdtemp(join(tmpdir(), 'orca-security-key-agent-'))
      tempDirs.push(directory)
      const identityPath = join(directory, 'agent-key')
      await writeFile(`${identityPath}.pub`, createOpenSshPublicKeyFixture(keyType))

      await expect(
        requiresSystemSshForSecurityKey(createTarget({ identityFile: identityPath }), null)
      ).resolves.toBe(true)
    }
  )

  it('ignores a stale FIDO2 sidecar beside a regular private identity', async () => {
    const identityPath = await writeKey(
      createOpenSshPrivateKeyFixture(['ssh-ed25519']),
      'regular-with-stale-sidecar'
    )
    await writeFile(`${identityPath}.pub`, createOpenSshPublicKeyFixture(ED25519_SECURITY_KEY))

    await expect(
      requiresSystemSshForSecurityKey(createTarget({ identityFile: identityPath }), null)
    ).resolves.toBe(false)
  })

  it('ignores stale imported identity paths when fresh config has regular keys', async () => {
    const staleKey = await writeKey(createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY]), 'stale')
    const regularKey = await writeKey(createOpenSshPrivateKeyFixture(['ssh-ed25519']), 'regular')
    const target = createTarget({
      source: 'ssh-config',
      configHost: 'workbox',
      identityFile: staleKey
    })

    await expect(
      requiresSystemSshForSecurityKey(target, { identityFile: [regularKey] })
    ).resolves.toBe(false)
  })

  it('keeps a manual target identity authoritative over resolved defaults', async () => {
    const regularKey = await writeKey(createOpenSshPrivateKeyFixture(['ssh-ed25519']), 'manual')
    const securityKey = await writeKey(
      createOpenSshPrivateKeyFixture([ED25519_SECURITY_KEY]),
      'resolved'
    )

    await expect(
      requiresSystemSshForSecurityKey(
        createTarget({ source: 'manual', identityFile: regularKey }),
        { identityFile: [securityKey] }
      )
    ).resolves.toBe(false)
  })

  it('degrades to ssh2 when identity files are missing or malformed', async () => {
    const malformedKey = await writeKey(Buffer.from('not a key'), 'malformed')
    await expect(
      requiresSystemSshForSecurityKey(createTarget({ identityFile: malformedKey }), null)
    ).resolves.toBe(false)
    await expect(
      requiresSystemSshForSecurityKey(
        createTarget({ identityFile: join(tmpdir(), 'missing-security-key') }),
        null
      )
    ).resolves.toBe(false)
  })
})
