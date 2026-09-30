import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DaemonConnectionLostError,
  DaemonProtocolError,
  DaemonRequestTimeoutError,
  SessionNotFoundError,
  TerminalHostGoneError,
  TerminalSessionOwnerUnverifiedError
} from './daemon-errors'
import { attachOnlyFailure, probeDaemonEndpoint } from './daemon-endpoint-verdict'
import { TerminalKilledError } from './daemon-pty-lifecycle-errors'

function connectError(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code, syscall: 'connect' })
}

describe('daemon endpoint verdict', () => {
  let dir: string
  let server: Server | null = null

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = null
    rmSync(dir, { recursive: true, force: true })
  })

  function endpoint(): { socketPath: string; pidPath: string } {
    dir = mkdtempSync(join(tmpdir(), 'daemon-endpoint-verdict-'))
    return { socketPath: join(dir, 'daemon-v35.sock'), pidPath: join(dir, 'daemon-v35.pid') }
  }

  it.skipIf(process.platform === 'win32')('reads an accepting listener as live', async () => {
    const { socketPath, pidPath } = endpoint()
    const listener = createServer()
    server = listener
    await new Promise<void>((resolve) => listener.listen(socketPath, resolve))

    await expect(probeDaemonEndpoint(socketPath, pidPath)).resolves.toEqual({ status: 'live' })
  })

  it('reads a missing endpoint as exited', async () => {
    const { socketPath, pidPath } = endpoint()

    await expect(probeDaemonEndpoint(socketPath, pidPath)).resolves.toEqual({ status: 'exited' })
  })

  // Why: the renderer answers any other attach error by dropping the pane's saved session and
  // starting over, which in a split tab leaves the original running with no tab.
  it.each([
    ['a request that timed out', new DaemonRequestTimeoutError('Request timed out')],
    ['a connection that dropped', new DaemonConnectionLostError('Connection lost')],
    ['a connect that timed out', new DaemonProtocolError('Connection timed out')],
    ['a connect the host could not complete', connectError('EAGAIN')]
  ])('leaves the owner unverified after %s', async (_label, error) => {
    const { socketPath, pidPath } = endpoint()

    await expect(
      attachOnlyFailure(error, 'wt@@1', { socketPath, pidPath })
    ).resolves.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
  })

  it('passes through answers only the owner can give', async () => {
    const { socketPath, pidPath } = endpoint()
    const absent = new SessionNotFoundError('wt@@1')
    const killed = new TerminalKilledError('wt@@1')

    await expect(attachOnlyFailure(absent, 'wt@@1', { socketPath, pidPath })).resolves.toBe(absent)
    await expect(attachOnlyFailure(killed, 'wt@@1', { socketPath, pidPath })).resolves.toBe(killed)
  })

  it('reports the daemon gone only once its endpoint is proven exited', async () => {
    const { socketPath, pidPath } = endpoint()

    await expect(
      attachOnlyFailure(connectError('ENOENT'), 'wt@@1', { socketPath, pidPath })
    ).resolves.toBeInstanceOf(TerminalHostGoneError)
  })
})
