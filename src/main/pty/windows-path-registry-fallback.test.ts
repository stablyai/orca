import { describe, expect, it } from 'vitest'
import { WindowsPathRegistryFallback } from './windows-path-registry-fallback'

const success = (segments: string[]) => ({ failed: false, segments })
const failure = () => ({ failed: true, segments: [] })

describe('WindowsPathRegistryFallback', () => {
  it('withholds an incomplete snapshot until every source has succeeded', () => {
    const fallback = new WindowsPathRegistryFallback(2)

    expect(fallback.commitReads([success(['C:\\Machine']), failure()])).toBeUndefined()
    expect(fallback.commitReads([failure(), success(['C:\\User'])])).toEqual([
      'C:\\Machine',
      'C:\\User'
    ])
  })

  it('uses each source independently when a later read fails', () => {
    const fallback = new WindowsPathRegistryFallback(2)
    fallback.commitReads([success(['C:\\OldMachine']), success(['C:\\OldUser'])])

    expect(fallback.commitReads([success(['C:\\NewMachine']), failure()])).toEqual([
      'C:\\NewMachine',
      'C:\\OldUser'
    ])
  })

  it('treats a successful empty source as authoritative', () => {
    const fallback = new WindowsPathRegistryFallback(2)
    fallback.commitReads([success(['C:\\Machine']), success(['C:\\User'])])

    expect(fallback.commitReads([failure(), success([])])).toEqual(['C:\\Machine'])
    expect(fallback.commitReads([failure(), failure()])).toEqual(['C:\\Machine'])
  })

  it('clears retained sources on reset', () => {
    const fallback = new WindowsPathRegistryFallback(2)
    fallback.commitReads([success(['C:\\Machine']), success(['C:\\User'])])

    fallback.reset()

    expect(fallback.commitReads([failure(), failure()])).toBeUndefined()
  })

  it('does not expose retained arrays to callers', () => {
    const fallback = new WindowsPathRegistryFallback(2)
    const machine = ['C:\\Machine']
    const first = fallback.commitReads([success(machine), success(['C:\\User'])])!

    machine[0] = 'C:\\MutatedInput'
    first[0] = 'C:\\MutatedOutput'

    expect(fallback.commitReads([failure(), failure()])).toEqual(['C:\\Machine', 'C:\\User'])
  })
})
