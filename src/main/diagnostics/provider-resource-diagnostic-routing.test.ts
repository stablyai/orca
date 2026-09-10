import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  routeProviderResourceDiagnostic,
  recordProviderResourceDiagnosticOutcome
} from './provider-resource-diagnostic-routing'

const getProvider = vi.hoisted(() => vi.fn())
vi.mock('../ipc/pty/provider/registry', () => ({ getProvider }))

describe('selected execution-owner diagnostic routing', () => {
  const query = { requestId: 'request-a', agent: 'claude', transcriptPath: '/synthetic/a.jsonl' }
  beforeEach(() => {
    vi.stubEnv('ORCA_PROVIDER_RESOURCE_DIAGNOSTICS', '1')
    getProvider.mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('routes the source SSH host and never substitutes local execution on contact loss', async () => {
    getProvider.mockImplementation(() => {
      throw new Error('synthetic disconnect')
    })
    expect(
      await routeProviderResourceDiagnostic({ executionHostId: 'ssh:source', query })
    ).toMatchObject({ verdict: 'unverifiable', reason: 'unreachable' })
    expect(getProvider.mock.calls).toEqual([['source']])
  })

  it('treats absent capabilities and paired runtimes as unsupported diagnostics', async () => {
    getProvider.mockReturnValue({})
    expect(
      (await routeProviderResourceDiagnostic({ executionHostId: 'local', query }))?.reason
    ).toBe('unsupported')
    getProvider.mockClear()
    expect(
      (await routeProviderResourceDiagnostic({ executionHostId: 'runtime:peer', query }))?.reason
    ).toBe('unsupported')
    expect(getProvider).not.toHaveBeenCalled()
  })

  it('does no provider work when opt-in is off or input is malformed', async () => {
    vi.stubEnv('ORCA_PROVIDER_RESOURCE_DIAGNOSTICS', '0')
    expect(await routeProviderResourceDiagnostic({ executionHostId: 'local', query })).toBeNull()
    vi.stubEnv('ORCA_PROVIDER_RESOURCE_DIAGNOSTICS', '1')
    expect(
      await routeProviderResourceDiagnostic({
        executionHostId: 'local',
        query: { ...query, requestId: 'x'.repeat(65) }
      })
    ).toBeNull()
    expect(getProvider).not.toHaveBeenCalled()
  })

  it('bounds unresolved source requests and releases capacity when they settle', async () => {
    let resolve: (value: null) => void = () => {}
    const waiting = new Promise<null>((done) => {
      resolve = done
    })
    getProvider.mockReturnValue({ providerResourceDiagnostic: () => waiting })
    const requests = Array.from({ length: 8 }, () =>
      routeProviderResourceDiagnostic({ executionHostId: 'local', query })
    )
    expect(
      (await routeProviderResourceDiagnostic({ executionHostId: 'local', query }))?.reason
    ).toBe('probe-capacity')
    expect(getProvider).toHaveBeenCalledTimes(8)
    resolve(null)
    await Promise.all(requests)
    expect(
      (await routeProviderResourceDiagnostic({ executionHostId: 'local', query }))?.reason
    ).toBe('unsupported')
  })

  it('logs only correlation/outcome and never lets a diagnostic sink fail a spawn', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('sink failed')
    })
    expect(() => recordProviderResourceDiagnosticOutcome('request-a', 'attached')).not.toThrow()
    expect(info).toHaveBeenCalledWith('[provider-resource-diagnostic]', {
      requestId: 'request-a',
      outcome: 'attached'
    })
  })
})
