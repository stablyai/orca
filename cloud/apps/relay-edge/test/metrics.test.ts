import { describe, expect, it, vi } from 'vitest'
import { metric, requestPlace } from '../src/metrics'
import type { Env } from '../src/env'

const withCf = (cf?: Record<string, string>) => {
  const request = new Request('https://edge.test/v1/connect/x')
  if (cf) {
    Object.defineProperty(request, 'cf', { value: cf })
  }
  return request
}

describe('metric place', () => {
  it('is continent/colo/country of the client ingress, with ? for a missing part', () => {
    expect(requestPlace(withCf({ continent: 'AS', colo: 'HKG', country: 'HK' }))).toBe('AS/HKG/HK')
    expect(requestPlace(withCf({ continent: 'AS', colo: 'SIN' }))).toBe('AS/SIN/?')
    expect(requestPlace(withCf())).toBe('local')
  })

  it('lands in blob 5, with no other request detail', () => {
    const writeDataPoint = vi.fn()
    const env = { METRICS: { writeDataPoint }, EDGE_VERSION: 'v1' } as unknown as Env
    metric(env, 'not_on_edge', 1, '', [], '', requestPlace(withCf({ continent: 'AS', colo: 'HKG', country: 'CN' })))
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['not_on_edge'],
      blobs: ['not_on_edge', '', 'v1', '', 'AS/HKG/CN'],
      doubles: [1]
    })
  })
})
