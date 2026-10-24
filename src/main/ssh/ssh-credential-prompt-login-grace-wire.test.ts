import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, utils, type Connection } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshConnection } from './connection/ssh-connection'
import { INITIAL_RETRY_DELAY_MS } from './connection/ssh-connection-timing'
import {
  createCallbacks,
  createResolvedConfig,
  createTarget
} from './connection/ssh-connection-test-fixtures'
import { initSshHostKeyStoreFile } from './ssh-host-key-store'
import { resolveWithSshG } from './config/ssh-g-config-resolution'
import type * as SshGConfigResolution from './config/ssh-g-config-resolution'

vi.mock('./config/ssh-g-config-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof SshGConfigResolution>()),
  resolveWithSshG: vi.fn()
}))

const PASSWORD = 'fixture-password'
// Longer than the connection's 2s retry delay, so a retry would start while the prompt is open.
const USER_ANSWER_DELAY_MS = 3_000

/**
 * A password host whose sshd gives up on an unanswered login (LoginGraceTime) before the user has
 * typed. The open password dialog must stay the one the user answers: the dropped socket may not
 * silently close it and open a new one.
 */
describe('a password prompt the server gives up on', () => {
  let profile: string
  let server: Server
  let conn: SshConnection | undefined
  const sockets = new Set<Connection>()

  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), 'orca-login-grace-wire-'))
    initSshHostKeyStoreFile(join(profile, 'host-keys.json'))
    vi.stubEnv('SSH_AUTH_SOCK', '')
    vi.mocked(resolveWithSshG).mockResolvedValue(
      createResolvedConfig({
        hostname: '127.0.0.1',
        identitiesOnly: true,
        identityAgent: 'none',
        proxyUseFdpass: false,
        strictHostKeyChecking: 'no'
      })
    )
  })

  afterEach(async () => {
    await conn?.disconnect()
    conn = undefined
    for (const socket of sockets) {
      socket.end()
    }
    sockets.clear()
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    vi.unstubAllEnvs()
    rmSync(profile, { recursive: true, force: true })
  })

  /** Every login gets a keyboard-interactive password prompt; the first is abandoned by the host. */
  async function startHost(): Promise<number> {
    let logins = 0
    server = new Server(
      { hostKeys: [utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
      (socket) => {
        sockets.add(socket)
        socket.on('error', () => {})
        socket.on('close', () => sockets.delete(socket))
        const login = ++logins
        socket.on('authentication', (context) => {
          if (context.method !== 'keyboard-interactive') {
            context.reject(['keyboard-interactive'])
            return
          }
          context.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
            if (answers[0] === PASSWORD) {
              context.accept()
            } else {
              context.reject(['keyboard-interactive'])
            }
          })
          if (login === 1) {
            setTimeout(() => socket.end(), 100)
          }
        })
        socket.on('ready', () => socket.on('session', (accept) => accept()))
      }
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Fixture did not bind')
    }
    return address.port
  }

  /** Behaves like the real dialog: an abort closes it, otherwise the user answers late. */
  function slowUser(answer: string | null) {
    return vi.fn(
      (
        _targetId: string,
        _kind: string,
        _detail: string,
        _echo?: boolean,
        signal?: AbortSignal
      ): Promise<string | null> =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(answer), USER_ANSWER_DELAY_MS)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve(null)
          })
        })
    )
  }

  it('keeps the open prompt and signs in with what the user typed', async () => {
    const port = await startHost()
    const onCredentialRequest = slowUser(PASSWORD)
    conn = new SshConnection(
      createTarget({ host: '127.0.0.1', port }),
      createCallbacks({ onCredentialRequest })
    )

    const connecting = conn.connect()
    void connecting.catch(() => {})
    await vi.waitFor(() => expect(onCredentialRequest).toHaveBeenCalled())
    const answered = onCredentialRequest.mock.results[0].value
    expect(await answered).toBe(PASSWORD)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true })
    try {
      await vi.advanceTimersByTimeAsync(0)
      // Answered but not yet used by the retry: a background dial must not replace it.
      await vi.waitFor(() => expect(conn?.isAwaitingCredential()).toBe(true), { timeout: 1_000 })
      await vi.advanceTimersByTimeAsync(INITIAL_RETRY_DELAY_MS)
      await connecting

      expect(conn.getState().status).toBe('connected')
      expect(onCredentialRequest).toHaveBeenCalledTimes(1)
      expect(conn.isAwaitingCredential()).toBe(false)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  }, 15_000)

  it('stops after the user cancels the prompt the server abandoned', async () => {
    const port = await startHost()
    const onCredentialRequest = slowUser(null)
    conn = new SshConnection(
      createTarget({ host: '127.0.0.1', port }),
      createCallbacks({ onCredentialRequest })
    )

    await expect(conn.connect()).rejects.toThrow(/cancelled/i)

    expect(conn.getState().status).toBe('auth-failed')
    expect(onCredentialRequest).toHaveBeenCalledTimes(1)
  }, 15_000)
})
