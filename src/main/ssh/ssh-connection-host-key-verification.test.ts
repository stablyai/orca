import { describe, expect, it, vi, beforeEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectAttempts, resetSshConnectionMocks, ssh2Mock } from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'

vi.mock('ssh2', async () => (await import('./ssh-connection-test-harness')).createSsh2Module())
vi.mock('./system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('./ssh-system-fallback', async () =>
  (await import('./ssh-connection-test-harness')).createSystemFallbackModule()
)
vi.mock('./ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('./ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)

const UNIDENTIFIABLE_HOST_KEY = Buffer.from('not-a-real-host-key-blob')

describe('SshConnection host key verification', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
  })

  // Proves the WIRING, not just the module: a verifier that decides correctly is worthless if the
  // handshake never consults it, and until this change ssh-connection accepted every key.
  it('refuses a host key whose own blob cannot be identified', async () => {
    ssh2Mock.presentedHostKey = UNIDENTIFIABLE_HOST_KEY
    const conn = new SshConnection(createTarget(), createCallbacks())

    await expect(conn.connect()).rejects.toThrow()
    expect(ssh2Mock.lastHostKeyAccepted, 'the handshake accepted an unidentifiable key').toBe(false)
  })

  it('accepts a well-formed host key on first contact', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()

    expect(ssh2Mock.lastHostKeyAccepted).toBe(true)
  })

  // The point of refusing the key is that we do not trust who is on the other end. ssh2 reports a
  // denied key as a generic auth failure, and an encrypted identity file makes the passphrase branch
  // eligible on message shape alone — so without an explicit abort we would hand the secret to the
  // party we just refused.
  it('never asks for a credential after refusing a host key', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'test-key')
    ssh2Mock.presentedHostKey = UNIDENTIFIABLE_HOST_KEY
    const onCredentialRequest = vi.fn(async () => 'secret')

    try {
      const conn = new SshConnection(
        createTarget({ identityFile: keyPath }),
        createCallbacks({ onCredentialRequest })
      )

      await expect(conn.connect()).rejects.toThrow(/host key verification failed/i)
      expect(onCredentialRequest).not.toHaveBeenCalled()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  // 'auth-failed' invites the user to re-enter credentials, which is the wrong thing to offer and
  // the wrong thing to blame; nothing about their credentials is wrong.
  it('surfaces a refused host key as an error rather than an auth failure', async () => {
    ssh2Mock.presentedHostKey = UNIDENTIFIABLE_HOST_KEY
    const conn = new SshConnection(createTarget(), createCallbacks())

    await expect(conn.connect()).rejects.toThrow()
    expect(conn.getState().status).toBe('error')
    expect(conn.getState().error).toMatch(/host key verification failed/i)
  })

  // Everyone's first connection happens before ~/.ssh/known_hosts exists — ssh creates it on its
  // own first connect. Treating a file that was never there as a source we failed to read would
  // refuse every connection a new profile ever makes, which is how a fail-closed rule turns into a
  // product that does not work.
  it('connects on first contact when no known_hosts file exists yet', async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'orca-ssh-home-'))
    vi.stubEnv('HOME', emptyHome)

    try {
      const conn = new SshConnection(createTarget(), createCallbacks())
      await conn.connect()

      expect(ssh2Mock.lastHostKeyAccepted).toBe(true)
      expect(conn.getState().status).toBe('connected')
    } finally {
      rmSync(emptyHome, { recursive: true, force: true })
    }
  })

  // A known_hosts that exists and will not open is the absence of evidence, so by product decision
  // we connect as ssh does — it warns and treats the host as unknown — rather than refusing an
  // ordinary offline Windows laptop whose OneDrive-backed file is a cloud placeholder. That we
  // record NOTHING in that state is covered end to end in
  // ssh-connection-host-key-store-wiring.test.ts, where the store is actually bound.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'still connects when a known_hosts file exists but cannot be read',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-ssh-home-'))
      mkdirSync(join(home, '.ssh'))
      const knownHosts = join(home, '.ssh', 'known_hosts')
      writeFileSync(knownHosts, '')
      chmodSync(knownHosts, 0o000)
      vi.stubEnv('HOME', home)

      try {
        const conn = new SshConnection(createTarget(), createCallbacks())
        await conn.connect()

        expect(ssh2Mock.lastHostKeyAccepted).toBe(true)
        expect(conn.getState().status).toBe('connected')
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  )

  // Retrying re-derives the same decision, so a ladder that treated this as transient would back off
  // against a host it has already refused until it gave up — burying the reason.
  it('does not retry a refused host key', async () => {
    ssh2Mock.presentedHostKey = UNIDENTIFIABLE_HOST_KEY
    const conn = new SshConnection(createTarget(), createCallbacks())

    await expect(conn.connect()).rejects.toThrow()
    expect(connectAttempts).toBe(1)
  })
})
