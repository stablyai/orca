import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEnvironmentFromPairingOffer } from '../../shared/runtime-environments'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { formatHostList } from '../format'
import { listPairedEnvironmentHosts } from './paired-host-inventory'

const { list, send } = vi.hoisted(() => ({ list: vi.fn(), send: vi.fn() }))
vi.mock('../runtime/environments', () => ({ listEnvironments: list }))
vi.mock('../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: send }))

function environment(id = 'env-one') {
  return createEnvironmentFromPairingOffer({
    id,
    name: 'same name',
    now: 1,
    offer: {
      v: 2,
      endpoint: `ws://${id}:6768`,
      deviceToken: `secret-${id}`,
      publicKeyB64: 'private-key'
    }
  })
}

const success = (result: unknown) => ({ ok: true, result, _meta: { runtimeId: 'remote' } })

describe('paired host inventory', () => {
  beforeEach(() => {
    list.mockReset().mockReturnValue([environment()])
    send.mockReset().mockResolvedValue(success({ hostPlatform: 'win32' }))
  })
  afterEach(() => vi.useRealTimers())

  it.each(['win32', 'linux', 'darwin'])(
    'reports the remote %s platform, not the CLI platform',
    async (platform) => {
      send.mockResolvedValue(success({ hostPlatform: platform }))
      const hosts = await listPairedEnvironmentHosts('unused')
      expect(hosts).toEqual([
        {
          kind: 'environment',
          name: 'same name',
          id: 'env-one',
          selector: '--environment env-one',
          platform,
          connected: true,
          connectionStatus: 'connected',
          connectionSource: 'probe'
        }
      ])
      expect(send).toHaveBeenCalledTimes(1)
      expect(formatHostList({ hosts })).toContain('connected [probe]')
      expect(formatHostList({ hosts })).not.toContain('connected (connected)')
    }
  )

  it('uses captured pairing identities for duplicate names and leaves saved metadata untouched', async () => {
    const environments = [environment('one'), environment('two')]
    const before = JSON.stringify(environments)
    list.mockReturnValue(environments)
    vi.stubEnv('ORCA_ENVIRONMENT', 'wrong-server')
    vi.stubEnv('ORCA_REMOTE_PAIRING_CODE', 'wrong-pairing')
    try {
      const hosts = await listPairedEnvironmentHosts('unused')
      expect(hosts.map((host) => host.selector)).toEqual(['--environment one', '--environment two'])
      expect(send.mock.calls.map((call) => call[0].deviceToken)).toEqual([
        'secret-one',
        'secret-two'
      ])
      expect(JSON.stringify(environments)).toBe(before)
      expect(JSON.stringify(hosts)).not.toMatch(/secret|private-key|ws:\/\//)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('falls back to the existing host.platform RPC on an older server', async () => {
    send.mockResolvedValueOnce(success({})).mockResolvedValueOnce(success({ platform: 'linux' }))
    expect((await listPairedEnvironmentHosts('unused'))[0]).toMatchObject({
      platform: 'linux',
      connected: true
    })
    expect(send.mock.calls.map((call) => call[1])).toEqual(['status.get', 'host.platform'])
  })

  it('keeps a verified connection when old servers cannot supply platform', async () => {
    send.mockResolvedValueOnce(success({})).mockRejectedValueOnce(new Error('method_not_found'))
    const [host] = await listPairedEnvironmentHosts('unused')
    expect(host).toMatchObject({ connected: true })
    expect(host).not.toHaveProperty('platform')
  })

  it.each([
    'runtime_timeout',
    'unauthorized',
    'invalid_runtime_response',
    'remote_runtime_unavailable'
  ])('preserves failed %s probes as unknown without leaking errors', async (code) => {
    send.mockRejectedValue(new RemoteRuntimeClientError(code, 'secret endpoint ws://private'))
    const [host] = await listPairedEnvironmentHosts('unused')
    expect(host).not.toHaveProperty('connected')
    expect(host).not.toHaveProperty('platform')
    expect(host.connectionStatus).toBe('unknown')
    expect(JSON.stringify(host)).not.toMatch(/secret|ws:\/\//)
  })

  it('retains rows for RPC refusals and invalid saved endpoints', async () => {
    list.mockReturnValue([environment('refused'), { ...environment('broken'), endpoints: [] }])
    send.mockResolvedValue({ ok: false, error: { code: 'unauthorized', message: 'secret' } })
    const hosts = await listPairedEnvironmentHosts('unused')
    expect(hosts.map((host) => host.probeError)).toEqual(['status_unavailable', 'probe_failed'])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('bounds fanout and the whole scan, aborts in-flight I/O, and never starts expired work', async () => {
    vi.useFakeTimers()
    list.mockReturnValue(Array.from({ length: 100 }, (_, index) => environment(String(index))))
    let active = 0
    let peak = 0
    send.mockImplementation(
      (_pairing, _method, _params, _timeout, _envelope, signal: AbortSignal) => {
        active++
        peak = Math.max(peak, active)
        return new Promise((_, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              active--
              reject(new Error('aborted'))
            },
            { once: true }
          )
        )
      }
    )
    const pending = listPairedEnvironmentHosts('unused')
    await vi.advanceTimersByTimeAsync(5_000)
    const hosts = await pending
    expect(hosts).toHaveLength(100)
    expect(peak).toBe(4)
    expect(active).toBe(0)
    expect(send).toHaveBeenCalledTimes(4)
    expect(hosts.every((host) => host.probeError === 'runtime_timeout')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does no network work without saved servers', async () => {
    list.mockReturnValue([])
    expect(await listPairedEnvironmentHosts('unused')).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })
})
