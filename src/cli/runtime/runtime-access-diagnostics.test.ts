import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCliStatus } from './status'
import { sendRequest } from './transport'
import { formatCliError, reportCliError } from '../cli-error'

const { connect, readMetadata } = vi.hoisted(() => ({
  connect: vi.fn(),
  readMetadata: vi.fn()
}))
vi.mock('node:net', () => ({ createConnection: connect }))
vi.mock('./metadata', () => ({ tryReadMetadata: readMetadata }))

const metadata = {
  runtimeId: 'runtime-test',
  pid: 12345,
  transports: [{ kind: 'unix' as const, endpoint: '/test/runtime.sock' }],
  authToken: 'secret-test-token',
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
afterEach(() => vi.restoreAllMocks())

function rejectConnection(code: string): void {
  socket.emit('error', Object.assign(new Error('must not leak endpoint or token'), { code }))
}

describe('runtime access diagnostics', () => {
  it.each(['EPERM', 'EACCES'])(
    'preserves socket %s in the existing error envelope',
    async (code) => {
      const pending = sendRequest(metadata, 'status.get', undefined, 1000)
      rejectConnection(code)
      await expect(pending).rejects.toMatchObject({
        code: 'runtime_unavailable',
        data: {
          reason: 'permission_denied',
          operation: 'connect',
          systemCode: code,
          processState: 'unverifiable'
        }
      })
      const error = await pending.catch((error: Error) => error)
      expect(String(error)).not.toMatch(
        /Restart|secret-test-token|\/test\/runtime.sock|must not leak/
      )
      expect(String(error)).toContain('sandbox and OS permissions')
      expect(formatCliError(error)).not.toMatch(/not running|orca open/)
      const output = vi.spyOn(console, 'log').mockImplementation(() => {})
      reportCliError(error, true)
      expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({
        ok: false,
        error: {
          code: 'runtime_unavailable',
          data: { reason: 'permission_denied', systemCode: code, processState: 'unverifiable' }
        }
      })
      expect(socket.write).not.toHaveBeenCalled()
    }
  )

  it.each(['EPERM', 'EACCES'])('does not report stale bootstrap after socket %s', async (code) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('process absent'), { code: 'ESRCH' })
    })
    const pending = getCliStatus('/test')
    rejectConnection(code)
    await expect(pending).rejects.toMatchObject({
      data: { operation: 'connect', systemCode: code }
    })
    expect(kill).not.toHaveBeenCalled()
  })

  it.each(['EPERM', 'EACCES'])('does not infer process absence from kill %s', async (code) => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('process probe denied'), { code })
    })
    const pending = getCliStatus('/test')
    rejectConnection('ECONNREFUSED')
    await expect(pending).rejects.toMatchObject({
      code: 'runtime_unavailable',
      data: {
        reason: 'permission_denied',
        operation: 'probe_process',
        systemCode: code,
        processState: 'unverifiable'
      }
    })
    expect(process.kill).toHaveBeenCalledWith(metadata.pid, 0)
  })

  it('keeps an unexpected process probe failure unverifiable', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('unknown failure')
    })
    const pending = getCliStatus('/test')
    rejectConnection('ECONNREFUSED')
    await expect(pending).rejects.toMatchObject({ data: { processState: 'unverifiable' } })
  })

  it.each(['ENOENT', 'ECONNREFUSED'])(
    'still reports stale bootstrap for %s plus ESRCH',
    async (code) => {
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('process absent'), { code: 'ESRCH' })
      })
      const pending = getCliStatus('/test')
      rejectConnection(code)
      await expect(pending).resolves.toMatchObject({
        result: {
          app: { running: false, pid: null },
          runtime: { state: 'stale_bootstrap', reachable: false }
        }
      })
    }
  )

  it('preserves starting when the process probe succeeds', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true)
    const pending = getCliStatus('/test')
    rejectConnection('ECONNREFUSED')
    await expect(pending).resolves.toMatchObject({
      result: {
        app: { running: true, pid: metadata.pid },
        runtime: { state: 'starting', reachable: false }
      }
    })
  })

  it('preserves ordinary transport failure recovery', async () => {
    const pending = sendRequest(metadata, 'status.get', undefined, 1000)
    rejectConnection('ECONNREFUSED')
    await expect(pending).rejects.toMatchObject({
      code: 'runtime_unavailable',
      data: undefined,
      message: 'Could not connect to the running Orca app. Restart Orca and try again.'
    })
    expect(formatCliError(await pending.catch((error: Error) => error))).toContain(
      "Run 'orca open' first"
    )
  })
})
