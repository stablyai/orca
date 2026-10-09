import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshConnection } from './ssh-connection'
import { createCallbacks, createResolvedConfig, createTarget } from './ssh-connection-test-fixtures'
import { initSshHostKeyStoreFile } from './ssh-host-key-store'
import { resolveWithSshG } from './ssh-config-parser'
import type * as SshConfigParser from './ssh-config-parser'
import {
  makeCredentialKey,
  startCredentialServer,
  WIRE_PASSPHRASE,
  WIRE_PASSWORD,
  type CredentialServerOptions
} from './ssh-credential-wire-fixture'

vi.mock('./ssh-config-parser', async (importOriginal) => ({
  ...(await importOriginal<typeof SshConfigParser>()),
  resolveWithSshG: vi.fn()
}))

describe('SSH credential negotiation over real sockets', () => {
  let profile: string
  let server: Awaited<ReturnType<typeof startCredentialServer>> | undefined
  let conn: SshConnection | undefined

  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), 'orca-credential-wire-'))
    initSshHostKeyStoreFile(join(profile, 'data.json'))
  })

  afterEach(async () => {
    await conn?.disconnect()
    await server?.close()
    vi.unstubAllEnvs()
    rmSync(profile, { recursive: true, force: true })
    conn = undefined
    server = undefined
  })

  async function connectFixture(
    keyContents: string[],
    onCredentialRequest: ReturnType<typeof createCallbacks>['onCredentialRequest'],
    options: CredentialServerOptions = {},
    identityAgent = 'none'
  ): Promise<SshConnection> {
    server = await startCredentialServer(options)
    const identityFile = keyContents.map((contents, index) => {
      const file = join(profile, `identity-${index}`)
      writeFileSync(file, contents, { mode: 0o600 })
      return file
    })
    vi.mocked(resolveWithSshG).mockResolvedValue(
      createResolvedConfig({
        hostname: '127.0.0.1',
        identityAgent,
        identityFile,
        proxyUseFdpass: false,
        strictHostKeyChecking: 'no'
      })
    )
    conn = new SshConnection(
      createTarget({ host: '127.0.0.1', port: server.port }),
      createCallbacks({ onCredentialRequest })
    )
    await conn.connect()
    return conn
  }

  it('skips encrypted keys when the server offers only password authentication', async () => {
    const key = makeCredentialKey(WIRE_PASSPHRASE)
    const request = vi.fn(async () => WIRE_PASSWORD)
    await connectFixture([key.privateKey], request, { methods: ['password'] })
    expect(request.mock.calls).toHaveLength(1)
    expect(request).toHaveBeenCalledWith(
      'target-1',
      'password',
      '127.0.0.1',
      undefined,
      expect.any(AbortSignal)
    )
    expect(server?.attempts).toEqual([['none', 'password']])
  })

  it.each([null, 'wrong-passphrase', WIRE_PASSPHRASE])(
    'continues to password after passphrase answer %s does not authenticate',
    async (answer) => {
      const key = makeCredentialKey(WIRE_PASSPHRASE)
      const request = vi.fn().mockResolvedValueOnce(answer).mockResolvedValueOnce(WIRE_PASSWORD)
      const connection = await connectFixture([key.privateKey], request)
      expect(connection.getState().status).toBe('connected')
      expect(server?.attempts).toHaveLength(1)
      expect(server?.attempts[0]?.at(-1)).toBe('password')
      expect(request.mock.calls.map((call) => call[1])).toEqual(['passphrase', 'password'])
    }
  )

  it.each([null, 'wrong-passphrase'])(
    'reconnects with the accepted password after passphrase answer %s',
    async (answer) => {
      const key = makeCredentialKey(WIRE_PASSPHRASE)
      const request = vi.fn().mockResolvedValueOnce(answer).mockResolvedValueOnce(WIRE_PASSWORD)
      const connection = await connectFixture([key.privateKey], request)
      await connection.reconnect()
      expect(connection.getState().status).toBe('connected')
      expect(server?.attempts).toHaveLength(2)
      expect(server?.attempts[1]).toEqual(['none', 'password'])
      expect(request).toHaveBeenCalledTimes(2)
    }
  )

  it('reuses a passphrase that decrypts an authorized key on reconnect', async () => {
    const key = makeCredentialKey(WIRE_PASSPHRASE)
    const request = vi.fn(async () => WIRE_PASSPHRASE)
    const connection = await connectFixture([key.privateKey], request, {
      acceptedKey: key.publicKey
    })
    await connection.reconnect()
    expect(connection.getState().status).toBe('connected')
    expect(request).toHaveBeenCalledTimes(1)
    expect(server?.attempts).toHaveLength(2)
    expect(server?.attempts.every((methods) => methods.at(-1) === 'publickey')).toBe(true)
  })

  it('keeps passphrases separate for different identity files', async () => {
    const first = makeCredentialKey('first-passphrase')
    const second = makeCredentialKey('second-passphrase')
    const options = { acceptedKey: second.publicKey }
    const request = vi
      .fn()
      .mockResolvedValueOnce('first-passphrase')
      .mockResolvedValueOnce('second-passphrase')
    const connection = await connectFixture([first.privateKey, second.privateKey], request, options)
    options.acceptedKey = first.publicKey
    await connection.reconnect()
    expect(connection.getState().status).toBe('connected')
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.map((call) => call[2])).toEqual([
      join(profile, 'identity-0'),
      join(profile, 'identity-1')
    ])
  })

  it('skips a malformed identity and tries the next usable key', async () => {
    const key = makeCredentialKey()
    const request = vi.fn(async () => null)
    await connectFixture(['not-a-private-key', key.privateKey], request, {
      acceptedKey: key.publicKey
    })
    expect(server?.attempts).toHaveLength(1)
    expect(request).not.toHaveBeenCalled()
  })

  it('continues from an unavailable agent through an encrypted key to password', async () => {
    const key = makeCredentialKey(WIRE_PASSPHRASE)
    const request = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(WIRE_PASSWORD)
    await connectFixture([key.privateKey], request, {}, join(profile, 'missing-agent.sock'))
    expect(server?.attempts).toHaveLength(1)
    expect(request.mock.calls.map((call) => call[1])).toEqual(['passphrase', 'password'])
  })

  it('does not request a password when the server only permits keys', async () => {
    const key = makeCredentialKey(WIRE_PASSPHRASE)
    const request = vi.fn(async () => null)
    await expect(
      connectFixture([key.privateKey], request, { methods: ['publickey'] })
    ).rejects.toThrow('All configured authentication methods failed')
    expect(request).toHaveBeenCalledTimes(1)
    expect(conn?.getState().status).toBe('auth-failed')
    expect(conn?.hasCachedCredential()).toBe(false)
    expect(server?.attempts).toHaveLength(1)
  })

  it('bounds password failure and does not cache a rejected password', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce('wrong-password')
      .mockResolvedValueOnce(WIRE_PASSWORD)
    await expect(connectFixture([], request, { methods: ['password'] })).rejects.toThrow(
      'All configured authentication methods failed'
    )
    expect(conn?.hasCachedCredential()).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
    await conn?.connect()
    expect(conn?.getState().status).toBe('connected')
    expect(request).toHaveBeenCalledTimes(2)
    expect(server?.attempts).toEqual([
      ['none', 'password'],
      ['none', 'password']
    ])
  })

  it('replaces an expired cached password with one fresh attempt', async () => {
    const options: CredentialServerOptions = { methods: ['password'], password: WIRE_PASSWORD }
    const request = vi
      .fn()
      .mockResolvedValueOnce(WIRE_PASSWORD)
      .mockResolvedValueOnce('replacement-password')
    const connection = await connectFixture([], request, options)
    options.password = 'replacement-password'
    await connection.reconnect()
    expect(connection.getState().status).toBe('connected')
    expect(request).toHaveBeenCalledTimes(2)
    expect(server?.attempts).toEqual([
      ['none', 'password'],
      ['none', 'password', 'password']
    ])
  })

  it.each(['password', 'keyboard-interactive'] as const)(
    'preserves partial key success before %s',
    async (secondFactor) => {
      const key = makeCredentialKey(WIRE_PASSPHRASE)
      const request = vi
        .fn()
        .mockResolvedValueOnce(WIRE_PASSPHRASE)
        .mockResolvedValueOnce(secondFactor === 'password' ? WIRE_PASSWORD : '123456')
      const connection = await connectFixture([key.privateKey], request, {
        acceptedKey: key.publicKey,
        methods: ['publickey'],
        secondFactor
      })
      expect(connection.getState().status).toBe('connected')
      expect(server?.attempts).toHaveLength(1)
      expect(server?.attempts[0]?.at(-1)).toBe(secondFactor)
      expect(request).toHaveBeenCalledTimes(2)
    }
  )

  it('refuses an unknown host before requesting any credential', async () => {
    const request = vi.fn(async () => WIRE_PASSWORD)
    server = await startCredentialServer()
    vi.mocked(resolveWithSshG).mockResolvedValue(
      createResolvedConfig({
        hostname: '127.0.0.1',
        identityAgent: 'none',
        proxyUseFdpass: false,
        strictHostKeyChecking: 'yes'
      })
    )
    conn = new SshConnection(
      createTarget({ host: '127.0.0.1', port: server.port }),
      createCallbacks({ onCredentialRequest: request })
    )
    await expect(conn.connect()).rejects.toThrow(/host key verification failed/i)
    expect(request).not.toHaveBeenCalled()
    expect(server.attempts).toEqual([[]])
  })

  it('ignores a late passphrase answer after disconnect', async () => {
    let answer: ((value: string | null) => void) | undefined
    const request = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          answer = resolve
        })
    )
    const key = makeCredentialKey(WIRE_PASSPHRASE)
    const connecting = connectFixture([key.privateKey], request)
    const rejected = expect(connecting).rejects.toThrow()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    await conn?.disconnect()
    answer?.(WIRE_PASSPHRASE)
    await rejected
    expect(conn?.getState().status).toBe('disconnected')
    expect(conn?.hasCachedCredential()).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
    expect(server?.attempts).toEqual([['none']])
  })
})
