import { describe, expect, it } from 'vitest'
import { getPiPrefillExtensionSource } from './prefill-extension-source'

describe('getPiPrefillExtensionSource', () => {
  it('accepts OMP session_start events without a reason field', () => {
    const source = getPiPrefillExtensionSource('omp')
    expect(source).toContain('process.env.ORCA_OMP_PREFILL')
    expect(source).not.toContain("event.reason !== 'startup'")
  })

  it('keeps Pi startup reason filtering', () => {
    expect(getPiPrefillExtensionSource('pi')).toContain("event.reason !== 'startup'")
  })
})
