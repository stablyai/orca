import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { formatCliError } from '../cli-error'
import { main } from '../index'
import recordedCodexDenial from './fixtures/codex-0.165.0-linux-connect-denied.json'
import { RuntimeClient } from './client'
import { launchOrcaApp } from './launch'
import { getCliStatus, getOfflineRuntimeAdmission } from './status'
import { preflightElectronServe } from './serve-electron-preflight'
import { sendRequest } from './transport'

const { connect, tryReadMetadata } = vi.hoisted(() => ({
  connect: vi.fn(),
  tryReadMetadata: vi.fn()
}))
vi.mock('node:net', () => ({ createConnection: connect }))
vi.mock('./metadata', () => ({
  tryReadMetadata,
  readMetadata: tryReadMetadata,
  getDefaultUserDataPath: () => '/test'
}))
vi.mock('./launch', () => ({ launchOrcaApp: vi.fn() }))
vi.mock('./runtime-remote-pairing', () => ({ resolveRemoteConnection: () => null }))

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

const RESTART_OR_ABSENT_ADVICE =
  /Restart Orca and try again|Orca is not running|Run 'orca open' first/

let socket: TestSocket

beforeEach(() => {
  vi.stubEnv('CODEX_SANDBOX', '')
  socket = new TestSocket()
  connect.mockReturnValue(socket)
  tryReadMetadata.mockReturnValue(metadata)
  mockKill('ESRCH')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

// Synthetic Node error/events; recorded CLI output supplies only the errno for the replay below.
function failConnect(code: string): void {
  socket.emit('error', Object.assign(new Error(`connect ${code} /private-runtime.sock`), { code }))
  socket.emit('close')
}

function mockKill(code?: string): void {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (code) {
      throw Object.assign(new Error(`kill ${code}`), { code })
    }
    return true
  })
}

async function deniedRequest(code: string): Promise<unknown> {
  const pending = sendRequest(metadata, 'status.get', undefined, 1000)
  failConnect(code)
  return pending.catch((failure: unknown) => failure)
}

describe('runtime access denied', () => {
  it.each(['EPERM', 'EACCES'])('classifies a %s connect without restart advice', async (code) => {
    const error = await deniedRequest(code)

    expect(error).toMatchObject({ code: 'runtime_access_denied', data: { systemCode: code } })
    expect(socket.write).not.toHaveBeenCalled()
    const human = formatCliError(error)
    expect(human).toContain(
      `Permission denied connecting to Orca (${code}). Orca may be running normally`
    )
    expect(human).toContain("Next step: Do not restart Orca or run 'orca open'")
    expect(human).not.toMatch(RESTART_OR_ABSENT_ADVICE)
    expect(human).not.toContain('private-runtime')
  })

  it('names the Codex sandbox only when synthetic CODEX_SANDBOX is set', async () => {
    vi.stubEnv('CODEX_SANDBOX', 'seatbelt')
    const human = formatCliError(await deniedRequest('EPERM'))

    expect(human).toContain('The Codex sandbox blocked this command from connecting to Orca')
    expect(human).toContain("Codex's existing escalation when the session permits it")
    expect(human).toContain('otherwise run the same command from a terminal outside the sandbox')
    expect(human).not.toMatch(RESTART_OR_ABSENT_ADVICE)
  })

  it('keeps ordinary connect failures as runtime_unavailable', async () => {
    expect(await deniedRequest('ECONNREFUSED')).toMatchObject({ code: 'runtime_unavailable' })
  })

  it.each(['EPERM', 'EACCES'])(
    'preserves %s with a hidden host PID through status and open without launching',
    async (code) => {
      const status = getCliStatus('/test')
      failConnect(code)
      await expect(status).rejects.toMatchObject({ code: 'runtime_access_denied' })

      const open = new RuntimeClient('/test', 1000, null, null).openOrca()
      failConnect(code)
      await expect(open).rejects.toMatchObject({ code: 'runtime_access_denied' })
      expect(launchOrcaApp).not.toHaveBeenCalled()
      expect(connect).toHaveBeenCalledTimes(2)
      expect(process.kill).not.toHaveBeenCalled()
    }
  )

  it('preserves recorded Codex Linux denial and recovery advice through status --json', async () => {
    vi.stubEnv('ORCA_PAIRING_CODE', '')
    vi.stubEnv('ORCA_ENVIRONMENT', '')
    vi.stubEnv('ORCA_REMOTE_PAIRING', '')
    mockKill(recordedCodexDenial.provenance.publishedPidProbeSystemCode)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    try {
      const pending = main(['status', '--json'], '/test')
      await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
      failConnect(recordedCodexDenial.response.error.data.systemCode)
      await pending

      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(recordedCodexDenial.response)
      expect(process.exitCode).toBe(recordedCodexDenial.exitCode)
      expect(process.kill).not.toHaveBeenCalled()
      expect(launchOrcaApp).not.toHaveBeenCalled()
    } finally {
      process.exitCode = priorExitCode
    }
  })
})

// Deterministic socket errno/events are synthetic, not a recorded sandbox transcript.
describe('private offline policy versus public connection truth', () => {
  it.each([
    ['alive-to-absent', [true, false], 'runtime_access_denied', 1],
    ['absent-to-alive', [false, true], true, 2],
    ['absent-to-absent', [false, false], false, 2]
  ] as const)(
    'samples denial at the original event and catch points: %s',
    async (_name, samples, outcome, count) => {
      const observations = [...samples]
      vi.mocked(process.kill).mockImplementation(() => {
        if (!observations.shift()) {
          throw Object.assign(new Error('gone'), { code: 'ESRCH' })
        }
        return true
      })
      const pending = getOfflineRuntimeAdmission('/test').catch((error: unknown) => error)
      failConnect('EPERM')
      expect(process.kill).toHaveBeenCalledTimes(1)
      // The transport's original await settles before the admission catch continuation.
      await Promise.resolve()
      expect(process.kill).toHaveBeenCalledTimes(1)
      await Promise.resolve()
      expect(process.kill).toHaveBeenCalledTimes(count)
      expect(await pending).toMatchObject(
        typeof outcome === 'string'
          ? { code: outcome }
          : { reachable: false, legacyPidRunning: outcome, pid: outcome ? metadata.pid : null }
      )
      expect(tryReadMetadata).toHaveBeenCalledTimes(1)
      expect(connect).toHaveBeenCalledTimes(1)
      expect(vi.mocked(process.kill).mock.calls.every(([pid]) => pid === metadata.pid)).toBe(true)
    }
  )

  function reply(value: unknown): void {
    socket.emit('connect')
    const request = JSON.parse(String(socket.write.mock.calls.at(-1)?.[0]))
    socket.emit(
      'data',
      `${JSON.stringify({
        id: request.id,
        ...Object(value),
        _meta: { runtimeId: metadata.runtimeId }
      })}\n`
    )
  }

  it('never probes for server denial, even with socket-shaped data; independent late error still maps', async () => {
    const pending = getOfflineRuntimeAdmission('/test').catch((error: unknown) => error)
    reply({
      ok: false,
      error: {
        code: 'runtime_access_denied',
        message: 'server denied',
        data: { code: 'EPERM', systemCode: 'EPERM' }
      }
    })
    await expect(pending).resolves.toMatchObject({ code: 'runtime_access_denied' })
    expect(process.kill).not.toHaveBeenCalled()
    socket.emit('error', Object.assign(new Error('late'), { code: 'EPERM' }))
    expect(process.kill).toHaveBeenCalledTimes(1)
    await expect(pending).resolves.toMatchObject({ code: 'runtime_access_denied' })
  })

  it.each([
    'EMFILE',
    'ECONNREFUSED',
    'ECONNRESET',
    'UNKNOWN',
    'sync',
    'close',
    'protocol',
    'request-id',
    'replacement',
    'projection',
    'server',
    'timeout'
  ])('retains the full outer catch domain and captured PID for %s', async (mode) => {
    vi.useFakeTimers()
    if (mode === 'sync') {
      connect.mockImplementationOnce(() => {
        throw new Error('construction failed')
      })
    }
    const pending = getOfflineRuntimeAdmission('/test')
    tryReadMetadata.mockReturnValue({ ...metadata, pid: 99999 })
    if (mode === 'timeout') {
      await vi.advanceTimersByTimeAsync(1000)
    } else if (mode === 'close') {
      socket.emit('close')
    } else if (mode === 'protocol') {
      socket.emit('data', 'invalid\n')
    } else if (mode === 'request-id') {
      socket.emit('data', '{"id":"wrong","ok":true,"result":{}}\n')
    } else if (mode === 'replacement') {
      socket.emit('connect')
      const request = JSON.parse(String(socket.write.mock.calls.at(-1)?.[0]))
      socket.emit(
        'data',
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result: {},
          _meta: { runtimeId: 'replacement' }
        })}\n`
      )
    } else if (mode === 'projection') {
      reply({ ok: true, result: null })
    } else if (mode === 'server') {
      reply({ ok: false, error: { code: 'runtime_unavailable', message: 'refused' } })
    } else if (mode !== 'sync') {
      failConnect(mode)
    }
    expect(await pending).toEqual({ reachable: false, legacyPidRunning: false, pid: null })
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(metadata.pid, 0)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(tryReadMetadata).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('does not probe incomplete metadata, and projects the entire success before admission', async () => {
    tryReadMetadata.mockReturnValueOnce({ ...metadata, authToken: null })
    expect(await getOfflineRuntimeAdmission('/test')).toEqual({
      reachable: false,
      legacyPidRunning: false,
      pid: null
    })
    expect(connect).not.toHaveBeenCalled()
    const pending = new RuntimeClient('/test', 1000, null, null).getOfflineRuntimeAdmission()
    reply({
      ok: true,
      result: { runtimeId: metadata.runtimeId, graphStatus: 'ready', authoritativeWindowId: null }
    })
    expect(await pending).toEqual({ reachable: true, legacyPidRunning: true, pid: metadata.pid })
    expect(process.kill).not.toHaveBeenCalled()
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it.each([0, -1, null])(
    'retains nonpositive or missing legacy PID %s without a syscall',
    async (pid) => {
      tryReadMetadata.mockReturnValueOnce({ ...metadata, pid })
      const pending = getOfflineRuntimeAdmission('/test')
      failConnect('EPERM')
      expect(await pending).toEqual({ reachable: false, legacyPidRunning: false, pid: null })
      expect(process.kill).not.toHaveBeenCalled()
    }
  )

  it.each(['EPERM', 'EINVAL', 'non-error'])(
    'retains unverifiable legacy PID on %s probe exception',
    async (code) => {
      vi.mocked(process.kill).mockImplementation(() => {
        throw code === 'non-error' ? code : Object.assign(new Error(code), { code })
      })
      const pending = getOfflineRuntimeAdmission('/test')
      failConnect('ECONNREFUSED')
      expect(await pending).toEqual({ reachable: false, legacyPidRunning: true, pid: metadata.pid })
      expect(process.kill).toHaveBeenCalledExactlyOnceWith(metadata.pid, 0)
    }
  )

  it('keeps malformed transport outside the private catch and public projection errors raw', async () => {
    tryReadMetadata.mockReturnValueOnce({ ...metadata, transports: [null] })
    await expect(getOfflineRuntimeAdmission('/test')).rejects.toBeInstanceOf(TypeError)
    expect(process.kill).not.toHaveBeenCalled()
    const pending = getCliStatus('/test').catch((error: unknown) => error)
    reply({ ok: true, result: null })
    const error = await pending
    expect(error).toBeInstanceOf(TypeError)
    expect(formatCliError(error)).toContain('null')
    expect(process.kill).not.toHaveBeenCalled()
  })
})

describe('serve default admission on synthetic socket denials', () => {
  it.each([
    [true, 'EPERM', 1, 'credentials'],
    [false, 'EPERM', 2, 'cannot be shown to be free'],
    [false, 'ENOENT', 2, null]
  ] as const)(
    'preserves event-time alive=%s and listener errno=%s',
    async (alive, listenerCode, connections, message) => {
      if (alive) {
        vi.mocked(process.kill).mockReturnValue(true)
      }
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const pending = preflightElectronServe({}, '/test', { platform: 'linux' })
      failConnect('EPERM')
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      if (!alive) {
        socket.emit('error', Object.assign(new Error('listener'), { code: listenerCode }))
      }
      expect(await pending).toBe(message ? 3 : null)
      expect(connect).toHaveBeenCalledTimes(connections)
      expect(process.kill).toHaveBeenCalledTimes(alive ? 1 : 2)
      if (message) {
        expect(String(stderr.mock.calls.at(-1)?.[0])).toContain(message)
      }
    }
  )
})
