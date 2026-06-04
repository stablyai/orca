import { describe, expect, it } from 'vitest'
import { isSidecarResponse, type SidecarResponse } from './sidecar-protocol'

describe('sidecar-protocol', () => {
  it('recognizes a well-formed response', () => {
    const ok: SidecarResponse = {
      id: 1,
      ok: true,
      result: { status: 'ok', bufferVersion: 0, locations: [], truncated: false }
    }
    expect(isSidecarResponse(ok)).toBe(true)
    expect(isSidecarResponse({ id: 1 })).toBe(false)
    expect(isSidecarResponse(null)).toBe(false)
  })
})
