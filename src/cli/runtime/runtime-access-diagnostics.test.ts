import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { RuntimeClient } from './client'
import { getCliStatus } from './status'
import { sendRequest } from './transport'
import { launchOrcaApp } from './launch'
import { formatCliError, reportCliError } from '../cli-error'
import { RuntimeClientError, RuntimeRpcFailureError } from './types'

const { connect, readMetadata } = vi.hoisted(() => ({
  connect: vi.fn(),
  readMetadata: vi.fn()
}))
vi.mock('node:net', () => ({ createConnection: connect }))
vi.mock('./metadata', () => ({ tryReadMetadata: readMetadata }))
vi.mock('./launch', () => ({ launchOrcaApp: vi.fn() }))
vi.mock('./runtime-remote-pairing', () => ({ resolveRemotePairing: () => null }))

const metadata: RuntimeMetadata = {
  runtimeId: 'runtime-test',
  pid: 12345,
  transports: [{ kind: 'unix', endpoint: '/private-runtime.sock' }],
  authToken: 'private-runtime-token',
  startedAt: 1
}

class TestSocket extends EventEmitter {
  setEncoding = vi.fn()
  end = vi.fn()
  destroy = vi.fn()
  write = vi.fn()
}

let socket: TestSocket

beforeEach(() => {
  socket = new TestSocket()
  connect.mockReturnValue(socket)
  readMetadata.mockReturnValue(metadata)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function rejectConnection(code: string): void {
  socket.emit('error', Object.assign(new Error('private endpoint detail'), { code }))
  socket.emit('close')
}

describe('runtime access diagnostics', () => {
  it.each(['EPERM', 'EACCES'])('preserves socket %s without restart advice', async (code) => {
    const pending = sendRequest(metadata, 'status.get', undefined, 1000)
    rejectConnection(code)
    const error = await pending.catch((failure: unknown) => failure)
    expect(error).toMatchObject({
      code: 'runtime_permission_denied',
      data: {
        reason: 'permission_denied',
        operation: 'connect',
        systemCode: code,
        processState: 'unverifiable',
        pid: metadata.pid
      }
    })
    expect(formatCliError(error)).toContain('sandbox and OS permissions')
    expect(formatCliError(error)).not.toMatch(/Restart|not running|orca open|private/)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    reportCliError(error, true)
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({
      ok: false,
      error: { code: 'runtime_permission_denied', data: { systemCode: code } }
    })
    expect(socket.write).not.toHaveBeenCalled()
  })

  it.each(['EPERM', 'EACCES'])('does not infer stale bootstrap after socket %s', async (code) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('hidden process'), { code: 'ESRCH' })
    })
    const pending = getCliStatus('/test')
    rejectConnection(code)
    await expect(pending).rejects.toMatchObject({
      code: 'runtime_permission_denied',
      data: { operation: 'connect', systemCode: code }
    })
    expect(kill).not.toHaveBeenCalled()
  })

  it.each([
    ['EPERM', 'runtime_permission_denied', 'permission_denied'],
    ['EACCES', 'runtime_permission_denied', 'permission_denied'],
    ['EIO', 'runtime_unverifiable', 'probe_failed'],
    [undefined, 'runtime_unverifiable', 'probe_failed']
  ] as const)(
    'keeps an unsuccessful PID probe (%s) unverifiable',
    async (code, expectedCode, expectedReason) => {
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('probe failed'), { code })
      })
      const pending = getCliStatus('/test')
      rejectConnection('ECONNREFUSED')
      const error = await pending.catch((failure: unknown) => failure)
      expect(error).toMatchObject({
        code: expectedCode,
        data: {
          reason: expectedReason,
          operation: 'probe_process',
          processState: 'unverifiable',
          pid: metadata.pid,
          ...(code ? { systemCode: code } : {})
        }
      })
      if (code === undefined) {
        expect(error).not.toHaveProperty('data.systemCode')
      }
      expect(formatCliError(error)).not.toMatch(/not running|orca open|Restart/)
    }
  )

  it.each(['ENOENT', 'ECONNREFUSED'])('retains stale bootstrap for %s plus ESRCH', async (code) => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('absent'), { code: 'ESRCH' })
    })
    const pending = getCliStatus('/test')
    rejectConnection(code)
    await expect(pending).resolves.toMatchObject({
      result: {
        app: { running: false, pid: null },
        runtime: { state: 'stale_bootstrap', reachable: false }
      }
    })
  })

  it('retains starting for a refused connection with a successful PID probe', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true)
    const pending = getCliStatus('/test')
    rejectConnection('ECONNREFUSED')
    await expect(pending).resolves.toMatchObject({
      result: { app: { running: true }, runtime: { state: 'starting' } }
    })
  })

  it('does not launch or poll Orca when the initial connection is denied', async () => {
    const client = new RuntimeClient('/test', 1000, null, null)
    const pending = client.openOrca()
    rejectConnection('EPERM')
    await expect(pending).rejects.toMatchObject({ code: 'runtime_permission_denied' })
    expect(launchOrcaApp).not.toHaveBeenCalled()
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('preserves permission diagnostics when wrapped in an RPC failure', () => {
    const error = new RuntimeRpcFailureError({
      id: 'request',
      ok: false,
      error: {
        code: 'runtime_permission_denied',
        message: 'Permission denied while connecting to the runtime.',
        data: { reason: 'permission_denied', processState: 'unverifiable' }
      },
      _meta: { runtimeId: 'runtime-test' }
    })
    expect(formatCliError(error)).not.toMatch(/not running|orca open|Restart/)
    expect(error).toBeInstanceOf(RuntimeClientError)
  })
})
