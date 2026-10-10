import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, utils, type Connection } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshConnection } from './ssh-connection'
import { createCallbacks, createResolvedConfig, createTarget } from './ssh-connection-test-fixtures'
import { initSshHostKeyStoreFile } from './ssh-host-key-store'
import { resolveWithSshG } from './ssh-config-parser'
import type * as SshConfigParser from './ssh-config-parser'

vi.mock('./ssh-config-parser', async (importOriginal) => ({
  ...(await importOriginal<typeof SshConfigParser>()),
  resolveWithSshG: vi.fn()
}))

describe('keyboard-interactive over a real SSH socket', () => {
  let profile: string
  let server: Server
  let conn: SshConnection | undefined
  const sockets = new Set<Connection>()

  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), 'orca-keyboard-wire-'))
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

  it.each([false, true])(
    'completes password then MFA with empty push response=%s',
    async (empty) => {
      const received: string[][] = []
      const methods: string[] = []
      server = new Server(
        { hostKeys: [utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
        (socket) => {
          sockets.add(socket)
          socket.on('error', () => {})
          socket.on('close', () => sockets.delete(socket))
          let passwordAccepted = false
          socket.on('authentication', (context) => {
            methods.push(context.method)
            if (context.method === 'password' && context.password === 'fixture-password') {
              passwordAccepted = true
              context.reject(['keyboard-interactive'], true)
            } else if (context.method === 'keyboard-interactive' && passwordAccepted) {
              context.prompt(
                [
                  {
                    prompt: empty ? 'Press Enter for push:' : 'Passcode or option (1-2):',
                    echo: true
                  }
                ],
                'MFA',
                'Choose verification:',
                (answers) => {
                  received.push(answers)
                  if (answers[0] === (empty ? '' : '1')) {
                    context.accept()
                  } else {
                    context.reject(['keyboard-interactive'])
                  }
                }
              )
            } else {
              context.reject(['password'])
            }
          })
        }
      )
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Fixture did not bind')
      }
      const onCredentialRequest = vi.fn(async (_id: string, kind: string) =>
        kind === 'password' ? 'fixture-password' : empty ? '' : '1'
      )
      conn = new SshConnection(
        createTarget({ host: '127.0.0.1', port: address.port }),
        createCallbacks({ onCredentialRequest })
      )
      await conn.connect()
      expect(conn.getState().status).toBe('connected')
      expect(received).toEqual([[empty ? '' : '1']])
      expect(methods).toContain('password')
      expect(onCredentialRequest).toHaveBeenLastCalledWith(
        'target-1',
        'keyboard-interactive',
        `MFA\nChoose verification:\n${empty ? 'Press Enter for push:' : 'Passcode or option (1-2):'}`,
        true,
        expect.any(AbortSignal)
      )
    }
  )
})
