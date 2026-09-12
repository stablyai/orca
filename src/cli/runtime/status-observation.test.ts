import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
} from '../../shared/protocol-version'
import { getCliStatus } from './status'
import { resolveRemotePairing } from './runtime-remote-pairing'
import { tryReadMetadata } from './metadata'
import { sendRequest } from './transport'
import { RuntimeClientError } from './types'
import { RuntimeClient } from './client'
import { launchOrcaApp } from './launch'
import { formatCliError, reportCliError } from '../cli-error'

vi.mock('./metadata', () => ({
  tryReadMetadata: vi.fn(),
  getDefaultUserDataPath: vi.fn()
}))
vi.mock('./runtime-remote-pairing', () => ({ resolveRemotePairing: vi.fn() }))
vi.mock('./transport', () => ({ sendRequest: vi.fn() }))
vi.mock('./launch', () => ({ launchOrcaApp: vi.fn() }))

const metadata = {
  runtimeId: 'synthetic-runtime',
  pid: 424242,
  authToken: 'synthetic-fixture',
  startedAt: 1,
  transports: [{ kind: 'unix' as const, endpoint: 'synthetic-endpoint' }]
}
const ready = {
  id: 'test',
  ok: true as const,
  _meta: { runtimeId: metadata.runtimeId },
  result: {
    runtimeId: metadata.runtimeId,
    graphStatus: 'ready',
    authoritativeWindowId: 1,
    desktopWindowStatus: 'available'
  }
}

beforeEach(() => {
  vi.mocked(resolveRemotePairing).mockReturnValue(null)
  vi.mocked(tryReadMetadata).mockReturnValue(metadata)
  vi.spyOn(process, 'kill').mockReturnValue(true)
  vi.mocked(sendRequest).mockRejectedValue(new RuntimeClientError('runtime_unavailable', 'test'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('local status evidence boundary', () => {
  it.each(['EPERM', 'EACCES', 'ECONNREFUSED', 'ENOENT', 'ETIMEDOUT'])(
    '%s is observation failure, never startup',
    async (code) => {
      vi.mocked(sendRequest).mockRejectedValue(
        new RuntimeClientError('runtime_unavailable', 'test', {
          transportFailure: { outcome: 'socket_error', code }
        })
      )
      await expect(getCliStatus('synthetic-folder')).rejects.toMatchObject({
        code: 'runtime_unavailable',
        data: {
          statusObservation: {
            version: 1,
            target: 'local',
            process: 'live',
            startup: 'unverifiable',
            runtime: 'unverifiable'
          },
          transportFailure: { code }
        }
      })
    }
  )
  it.each(['runtime_timeout', 'invalid_runtime_response', 'runtime_unavailable'])(
    'preserves %s code without a successful state',
    async (code) => {
      vi.mocked(sendRequest).mockRejectedValue(new RuntimeClientError(code, 'test'))
      await expect(getCliStatus('synthetic-folder')).rejects.toMatchObject({
        code
      })
    }
  )
  it.each(['EPERM', 'EACCES', 'EINVAL'])('PID %s is unverifiable', async (code) => {
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('test'), { code })
    })
    await expect(getCliStatus('synthetic-folder')).rejects.toMatchObject({
      data: { statusObservation: { process: 'unverifiable' } }
    })
  })
  it('positive ESRCH and refused endpoint permit stale bootstrap', async () => {
    vi.mocked(sendRequest).mockRejectedValue(
      new RuntimeClientError('runtime_unavailable', 'test', {
        transportFailure: {
          outcome: 'socket_error',
          code: 'ECONNREFUSED',
          connected: false
        }
      })
    )
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('test'), { code: 'ESRCH' })
    })
    expect((await getCliStatus('synthetic-folder')).result).toMatchObject({
      app: { running: false },
      runtime: { state: 'stale_bootstrap' },
      graph: { state: 'not_running' }
    })
  })
  it.each([0, -1, Number.NaN, 1.5])('invalid PID %s cannot prove exit', async (pid) => {
    vi.mocked(tryReadMetadata).mockReturnValue({ ...metadata, pid })
    await expect(getCliStatus('synthetic-folder')).rejects.toMatchObject({
      data: { statusObservation: { process: 'unverifiable' } }
    })
    expect(process.kill).not.toHaveBeenCalled()
  })
  it('incomplete bootstrap with a visible PID cannot prove exit', async () => {
    vi.mocked(tryReadMetadata).mockReturnValue({ ...metadata, transports: [] })
    await expect(getCliStatus('synthetic-folder')).rejects.toMatchObject({
      data: { statusObservation: { process: 'live' } }
    })
    expect(sendRequest).not.toHaveBeenCalled()
  })
  it('RPC rejection never becomes boot progress or republishes arbitrary host data', async () => {
    vi.mocked(sendRequest).mockResolvedValue({
      id: 'test',
      ok: false,
      error: {
        code: 'permission_denied',
        message: 'fixture',
        data: { privateFixture: 'do-not-copy' }
      },
      _meta: { runtimeId: metadata.runtimeId }
    })
    const error = await getCliStatus('synthetic-folder').catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: 'permission_denied',
      data: { statusObservation: { process: 'live' } }
    })
    expect(JSON.stringify(error)).not.toContain('do-not-copy')
  })
  it.each(['ready', 'unavailable', 'reloading'])(
    'authenticated %s graph remains host-owned without PID probing',
    async (graphStatus) => {
      vi.mocked(sendRequest).mockResolvedValue({
        ...ready,
        result: {
          ...ready.result,
          graphStatus,
          desktopWindowStatus: 'initializing'
        }
      })
      expect((await getCliStatus('synthetic-folder')).result).toMatchObject({
        runtime: {
          state: graphStatus === 'ready' ? 'ready' : 'graph_not_ready',
          reachable: true
        },
        graph: { state: graphStatus },
        app: { desktopWindowStatus: 'initializing' }
      })
      expect(process.kill).not.toHaveBeenCalled()
    }
  )
  it('human and JSON errors retain uncertainty without launch advice', async () => {
    const error = await getCliStatus('synthetic-folder').catch((e: unknown) => e)
    expect(formatCliError(error)).not.toMatch(/not running|orca open|Restart Orca/)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    reportCliError(error, true)
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      ok: false,
      error: {
        code: 'runtime_unavailable',
        data: { statusObservation: { process: 'live' } }
      }
    })
  })
})

describe('open owns only its own bounded startup wait', () => {
  const client = () => new RuntimeClient('synthetic-folder', 100, null, null)
  it('does not launch or wait over an existing unobservable runtime', async () => {
    await expect(client().openOrca(500)).rejects.toMatchObject({
      code: 'runtime_unavailable'
    })
    expect(launchOrcaApp).not.toHaveBeenCalled()
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })
  it('waits through observation failure after its own launch and returns positive ready evidence', async () => {
    vi.useFakeTimers()
    vi.mocked(tryReadMetadata).mockReturnValueOnce(null)
    vi.mocked(sendRequest)
      .mockRejectedValueOnce(new RuntimeClientError('runtime_unavailable', 'test'))
      .mockResolvedValue(ready)
    const pending = client().openOrca(1000)
    await vi.runAllTimersAsync()
    expect((await pending).result.runtime.state).toBe('ready')
    expect(launchOrcaApp).toHaveBeenCalledOnce()
  })
  it('returns the observation failure at its finite deadline', async () => {
    vi.useFakeTimers()
    vi.mocked(tryReadMetadata).mockReturnValueOnce(null)
    const pending = expect(client().openOrca(500)).rejects.toMatchObject({
      code: 'runtime_unavailable',
      data: { statusObservation: { startup: 'unverifiable' } }
    })
    await vi.runAllTimersAsync()
    await pending
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(launchOrcaApp).toHaveBeenCalledOnce()
  })
})

describe('remote status and older optional fields', () => {
  function remoteClient() {
    vi.mocked(resolveRemotePairing).mockReturnValue({
      v: 2,
      endpoint: 'ws://synthetic.invalid',
      publicKeyB64: 'synthetic',
      deviceToken: 'synthetic'
    })
    return new RuntimeClient('synthetic-folder', 100, null, null)
  }
  it('uses old host window evidence without requiring new observation fields', async () => {
    const client = remoteClient()
    vi.spyOn(client, 'call').mockResolvedValue({
      ...ready,
      result: {
        runtimeId: metadata.runtimeId,
        graphStatus: 'ready',
        authoritativeWindowId: 2,
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
        optionalFutureField: 'ignored'
      }
    })
    expect((await client.getCliStatus()).result).toMatchObject({
      app: { running: true, pid: null, desktopWindowStatus: 'available' },
      runtime: { state: 'ready', reachable: true }
    })
    expect(process.kill).not.toHaveBeenCalled()
    expect(tryReadMetadata).not.toHaveBeenCalled()
  })
  it('remote contact loss rejects without local PID inference or app launch', async () => {
    const client = remoteClient()
    const failure = new RuntimeClientError('runtime_unavailable', 'remote observation unavailable')
    vi.spyOn(client, 'call').mockRejectedValue(failure)
    await expect(client.openOrca(100)).rejects.toBe(failure)
    expect(process.kill).not.toHaveBeenCalled()
    expect(tryReadMetadata).not.toHaveBeenCalled()
    expect(launchOrcaApp).not.toHaveBeenCalled()
  })
})
