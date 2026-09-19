import { EventEmitter } from 'node:events'
import type * as FileSystem from 'node:fs'
import type * as ChildProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { preflightServeRuntime, SERVE_RUNTIME_PROBE_TIMEOUT_MS } from './serve-runtime-preflight'
import { serveOrcaApp } from './launch'
import { formatCliError } from '../cli-error'

const { read, connect, spawn } = vi.hoisted(() => ({
  read: vi.fn(),
  connect: vi.fn(),
  spawn: vi.fn()
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystem>()),
  readFileSync: read
}))
vi.mock('node:net', () => ({ createConnection: connect }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn
}))

class ProbeSocket extends EventEmitter {
  destroy = vi.fn()
  write = vi.fn()
}
let socket: ProbeSocket
const metadata = {
  pid: 12345,
  authToken: 'private-token',
  transports: [{ kind: 'unix', endpoint: '/private-endpoint.sock' }]
}
function osError(code?: string): Error {
  return Object.assign(new Error('private-path-and-token'), { code })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('ORCA_USER_DATA_PATH', '/test-profile')
  vi.stubEnv('ORCA_APP_EXECUTABLE', '/test-electron')
  spawn.mockImplementation(() => {
    throw new Error('unexpected duplicate launch')
  })
  read.mockReturnValue(JSON.stringify(metadata))
  socket = new ProbeSocket()
  connect.mockReturnValue(socket)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('serve runtime preflight', () => {
  it('allows missing metadata without probing or checking a PID', () => {
    read.mockImplementation(() => {
      throw osError('ENOENT')
    })
    expect(preflightServeRuntime('/test-profile')).toBeNull()
    expect(connect).not.toHaveBeenCalled()
  })

  it.each(['EPERM', 'EACCES', 'EIO', undefined])(
    'preserves metadata read failure %s',
    async (code) => {
      read.mockImplementation(() => {
        throw osError(code)
      })
      await expect(preflightServeRuntime('/test-profile')).resolves.toMatchObject({
        code:
          code === 'EPERM' || code === 'EACCES'
            ? 'runtime_permission_denied'
            : 'runtime_serve_refused',
        data: { processState: 'unverifiable', systemCode: code }
      })
      expect(connect).not.toHaveBeenCalled()
    }
  )

  it.each([
    '{',
    'null',
    '42',
    '{}',
    JSON.stringify({ transports: [null] }),
    JSON.stringify({ transports: [{ kind: 'unix', endpoint: 1234 }] }),
    JSON.stringify({ transports: [{ kind: 'unix', endpoint: ' ' }] }),
    JSON.stringify({ transports: [{ kind: 'websocket', endpoint: 'wss://remote.invalid' }] })
  ])('refuses invalid local discovery without dialing: %s', async (contents) => {
    read.mockReturnValue(contents)
    await expect(preflightServeRuntime('/test-profile')).resolves.toMatchObject({
      data: { reason: 'invalid_metadata', processState: 'unverifiable' }
    })
    expect(connect).not.toHaveBeenCalled()
  })

  it.each(['unix', 'named-pipe'])('supports legacy %s transport metadata', async (kind) => {
    read.mockReturnValue(JSON.stringify({ transport: { kind, endpoint: 'legacy-endpoint' } }))
    const pending = preflightServeRuntime('/test-profile')
    expect(connect).toHaveBeenCalledWith({ path: 'legacy-endpoint' })
    socket.emit('connect')
    await expect(pending).resolves.toMatchObject({ data: { reason: 'endpoint_accepting' } })
    expect(socket.write).not.toHaveBeenCalled()
    expect(socket.destroy).toHaveBeenCalledOnce()
  })

  it.each(['ENOENT', 'ECONNREFUSED'])('allows a definitively absent listener: %s', async (code) => {
    const pending = preflightServeRuntime('/test-profile')
    socket.emit('error', osError(code))
    socket.emit('close')
    await expect(pending).resolves.toBeNull()
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['EPERM', 'EACCES', 'EIO', undefined])(
    'refuses an unverifiable connection: %s',
    async (code) => {
      const pending = preflightServeRuntime('/test-profile')
      socket.emit('error', osError(code))
      socket.emit('close')
      const error = await pending
      expect(error).toMatchObject({
        code:
          code === 'EPERM' || code === 'EACCES'
            ? 'runtime_permission_denied'
            : 'runtime_serve_refused',
        data: {
          reason: code === 'EPERM' || code === 'EACCES' ? 'permission_denied' : 'connect_failed',
          systemCode: code
        }
      })
      expect(formatCliError(error)).not.toMatch(/already running|Restart|delete|private-|12345/)
      expect(() => socket.emit('error', osError('EIO'))).not.toThrow()
      expect(socket.destroy).toHaveBeenCalledOnce()
    }
  )

  it('bounds a silent connection and ignores a late success', async () => {
    const pending = preflightServeRuntime('/test-profile')
    await vi.advanceTimersByTimeAsync(SERVE_RUNTIME_PROBE_TIMEOUT_MS)
    socket.emit('connect')
    await expect(pending).resolves.toMatchObject({ data: { reason: 'timeout' } })
    expect(socket.destroy).toHaveBeenCalledOnce()
  })

  it('refuses a connection that closes without evidence', async () => {
    const pending = preflightServeRuntime('/test-profile')
    socket.emit('close')
    await expect(pending).resolves.toMatchObject({ data: { reason: 'connection_closed' } })
  })

  it('classifies synchronous connection errors without exposing their message', async () => {
    connect.mockImplementationOnce(() => {
      throw osError('EPERM')
    })
    const error = await preflightServeRuntime('/test-profile')
    expect(error).toMatchObject({ code: 'runtime_permission_denied' })
    expect(formatCliError(error)).not.toContain('private-')
  })
})

describe('serve launch boundary', () => {
  it.each([{}, { json: true }, { recipeJson: true, json: true, projectRoot: '/workspace' }])(
    'refuses before spawn and preserves the output channel: %j',
    async (args) => {
      const stdout = vi.spyOn(console, 'log').mockImplementation(() => {})
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
      const kill = vi.spyOn(process, 'kill')
      const pending = serveOrcaApp(args)
      socket.emit('error', osError('EPERM'))
      await expect(pending).resolves.toBe(3)
      expect(spawn).not.toHaveBeenCalled()
      expect(kill).not.toHaveBeenCalled()
      if ('json' in args && args.json && !('recipeJson' in args)) {
        expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({
          ok: false,
          error: { code: 'runtime_permission_denied', data: { processState: 'unverifiable' } }
        })
        expect(stderr).not.toHaveBeenCalled()
      } else {
        expect(stdout).not.toHaveBeenCalled()
        expect(stderr).toHaveBeenCalledOnce()
      }
    }
  )
})
