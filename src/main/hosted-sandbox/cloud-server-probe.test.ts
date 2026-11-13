import { describe, expect, it } from 'vitest'
import { classifyProbeFailure, probeCloudServer } from './cloud-server-probe'

describe('probeCloudServer (EP-8)', () => {
  it('tells a refused pairing apart from a server that does not answer', () => {
    expect(classifyProbeFailure('unauthorized', '')).toBe('rejected')
    expect(classifyProbeFailure('device_revoked', '')).toBe('rejected')
    expect(classifyProbeFailure(undefined, 'Remote Orca runtime rejected the pairing token.')).toBe(
      'rejected'
    )
    expect(classifyProbeFailure('timeout', 'Request timed out')).toBe('no_answer')
  })

  it('asks the server for its status, briefly', async () => {
    const calls: unknown[][] = []
    const ok = async (...args: unknown[]) => {
      calls.push(args)
      return { id: 'status.get', ok: true as const, result: {}, _meta: { runtimeId: 'r' } }
    }
    expect(await probeCloudServer('/data', 'env-1', ok)).toBe('ok')
    expect(calls[0]?.slice(1, 5)).toEqual(['env-1', 'status.get', undefined, 5_000])
    const refused = async () => {
      throw Object.assign(new Error('Remote Orca runtime rejected the pairing token.'), {
        code: 'unauthorized'
      })
    }
    expect(await probeCloudServer('/data', 'env-1', refused)).toBe('rejected')
    expect(await probeCloudServer('/data', '', ok)).toBe('no_answer')
  })
})
