import { describe, expect, it } from 'vitest'

import {
  canonicalizeCycle,
  diffBaseline,
  parseBaseline
} from './check-circular-imports-ratchet.mjs'

describe('canonicalizeCycle', () => {
  it('rewrites paths relative to the scan dir into repo-relative, > -joined form', () => {
    expect(canonicalizeCycle(['store/index.ts', 'lib/repos.ts'])).toBe(
      'src/renderer/src/lib/repos.ts > src/renderer/src/store/index.ts'
    )
  })

  it('resolves ../ segments that reach outside the scan dir', () => {
    // Two levels up from src/renderer/src (the scan dir) reaches src/ itself,
    // matching how madge reports edges into src/shared/* in the real scan.
    expect(canonicalizeCycle(['../../shared/types.ts', 'store/index.ts'])).toBe(
      'src/renderer/src/store/index.ts > src/shared/types.ts'
    )
  })

  it('produces the same canonical string regardless of which node the cycle starts from', () => {
    const a = canonicalizeCycle(['lib/a.ts', 'lib/b.ts', 'lib/c.ts'])
    const b = canonicalizeCycle(['lib/b.ts', 'lib/c.ts', 'lib/a.ts'])
    const c = canonicalizeCycle(['lib/c.ts', 'lib/a.ts', 'lib/b.ts'])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(a).toBe(
      'src/renderer/src/lib/a.ts > src/renderer/src/lib/b.ts > src/renderer/src/lib/c.ts'
    )
  })
})

describe('parseBaseline', () => {
  it('drops comments and blank lines', () => {
    const b = parseBaseline('# header\n\na.ts > b.ts\nc.ts > d.ts\n')
    expect(b).toEqual(new Set(['a.ts > b.ts', 'c.ts > d.ts']))
  })
})

describe('diffBaseline', () => {
  it('reports added and stale entries', () => {
    const { added, stale } = diffBaseline(
      ['b.ts > c.ts', 'c.ts > d.ts'],
      new Set(['a.ts > b.ts', 'b.ts > c.ts'])
    )
    expect(added).toEqual(['c.ts > d.ts']) // new cycle
    expect(stale).toEqual(['a.ts > b.ts']) // cycle no longer exists
  })

  it('is clean when current matches baseline', () => {
    const { added, stale } = diffBaseline(['a.ts > b.ts'], new Set(['a.ts > b.ts']))
    expect(added).toEqual([])
    expect(stale).toEqual([])
  })
})
