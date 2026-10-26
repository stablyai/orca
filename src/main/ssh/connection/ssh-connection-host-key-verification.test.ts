import { describe, expect, it, vi, beforeEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectAttempts, ssh2Mock } from '../__tests__/ssh-connection-test-client'
import { resetSshConnectionMocks } from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'

vi.mock('ssh2', async () =>
  (await import('../__tests__/ssh-connection-test-client')).createSsh2Module()
)
vi.mock('../system-transport/system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('../system-transport/system-ssh-args', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshArgsMocks(await importOriginal())
)
vi.mock('../system-transport/system-ssh-command', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshCommandMocks(await importOriginal())
)
vi.mock('../system-transport/system-ssh-file-binary-transfer', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshFileBinaryTransferMocks(
    await importOriginal()
  )
)
vi.mock('../system-transport/system-ssh-file-transfer', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshFileTransferMocks(
    await importOriginal()
  )
)
vi.mock('../ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('../config/ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)
vi.mock('../config/ssh-g-config-resolution', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSshGConfigResolutionMocks(
    await importOriginal()
  )
)

const UNIDENTIFIABLE_HOST_KEY = Buffer.from('not-a-real-host-key-blob')

describe('SshConnection host key verification', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
  })

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

  // A rejected host key must bypass credential fallbacks or auth-shaped errors could disclose a secret to the refused peer.
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

  it('surfaces a refused host key as an error rather than an auth failure', async () => {
    ssh2Mock.presentedHostKey = UNIDENTIFIABLE_HOST_KEY
    const conn = new SshConnection(createTarget(), createCallbacks())

    await expect(conn.connect()).rejects.toThrow()
    expect(conn.getState().status).toBe('error')
    expect(conn.getState().error).toMatch(/host key verification failed/i)
  })

  // Absent known_hosts is normal for new profiles; it cannot be treated as withheld evidence.
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

  // Unreadable known_hosts connects as SSH does, including cloud-placeholder files, but must record no trust; store-wiring tests prove that boundary.
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

  it('does not retry a refused host key', async () => {
    ssh2Mock.presentedHostKey = UNIDENTIFIABLE_HOST_KEY
    const conn = new SshConnection(createTarget(), createCallbacks())

    await expect(conn.connect()).rejects.toThrow()
    expect(connectAttempts).toBe(1)
  })
})
