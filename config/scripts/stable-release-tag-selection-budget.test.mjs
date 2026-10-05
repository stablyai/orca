import { describe, expect, it } from 'vitest'
import { selectLatestStableReleaseTag } from './stable-release-tags.mjs'

function expectedLatest(tags) {
  let latest = null
  let latestParts = []
  for (const tag of tags) {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)
    if (!match) {
      continue
    }
    const parts = match.slice(1).map((part) => {
      const value = Number.parseInt(part, 10)
      return Number.isFinite(value) ? value : 0
    })
    let comparison = 0
    for (let index = 0; index < 3 && comparison === 0; index++) {
      comparison = parts[index] - (latestParts[index] ?? 0)
    }
    if (latest === null || comparison >= 0) {
      latest = tag
      latestParts = parts
    }
  }
  return latest
}

function measurePartMaps(tags) {
  const nativeMap = Array.prototype.map
  let partMaps = 0
  Array.prototype.map = function (callback, thisArg) {
    partMaps++
    return nativeMap.call(this, callback, thisArg)
  }
  let result
  try {
    result = selectLatestStableReleaseTag(tags)
  } finally {
    Array.prototype.map = nativeMap
  }
  return { result, partMaps }
}

describe('stable release tag selection work', () => {
  it.each([0, 1, 12, 128, 1000])('bounds numeric parsing for %i Git tag strings', (count) => {
    const tags = Array.from(
      { length: count },
      (_, index) => `v1.${(index * 37) % 17}.${(index * 101) % (count + 1)}`
    )
    const input = [...tags]
    const expected = expectedLatest(tags)
    const measured = measurePartMaps(Object.freeze(tags))
    expect(measured.result).toBe(expected)
    expect(tags).toEqual(input)
    // Each unchanged comparator converts the two triples through four maps.
    expect(measured.partMaps).toBeLessThanOrEqual(4 * Math.max(0, count - 1))
  })

  it('preserves tie spelling, numeric fallback and invalid-tag admission', () => {
    const cases = [
      { tags: [], expected: null },
      { tags: ['nightly', 'mobile-v1.2.3', 'v1.2.3-rc.1'], expected: null },
      { tags: ['v0001.4.003', 'v1.04.3'], expected: 'v1.04.3' },
      { tags: ['v1.04.3', 'v0001.4.003'], expected: 'v0001.4.003' },
      { tags: ['v1.2.3', 'v1.2.3\n'], expected: 'v1.2.3' },
      { tags: ['v1.2.3\r\n', 'v0.0.1'], expected: 'v0.0.1' },
      { tags: [`v${'9'.repeat(400)}.1.2`, 'v0.1.2'], expected: 'v0.1.2' },
      {
        tags: ['v9007199254740993.1.0', 'v9007199254740992.1.0'],
        expected: 'v9007199254740992.1.0'
      }
    ]
    for (const { tags, expected } of cases) {
      const input = [...tags]
      expect(selectLatestStableReleaseTag(Object.freeze(tags))).toBe(expected)
      expect(tags).toEqual(input)
    }
    const sparse = []
    sparse.length = 12
    sparse[3] = 'v1.2.3'
    sparse[8] = 'v2.0.0'
    expect(selectLatestStableReleaseTag(Object.freeze(sparse))).toBe('v2.0.0')
  })

  it('selects the same latest spelling across ordinary version namespaces and repeated calls', () => {
    let randomState = 673151
    const next = () => {
      randomState = (randomState * 1664525 + 1013904223) >>> 0
      return randomState
    }
    for (let seed = 0; seed < 256; seed++) {
      const tags = []
      for (let index = 0, count = next() % 129; index < count; index++) {
        const triple = [next() % 13, next() % 17, next() % 257]
        const prefix = next() % 8 === 0 ? 'mobile-v' : 'v'
        const suffix = next() % 9 === 0 ? '-rc.1' : ''
        tags.push(`${prefix}${triple.join('.')}${suffix}`)
        if (index % 11 === 0) {
          tags.push(tags.at(-1))
        }
      }
      const input = [...tags]
      const expected = expectedLatest(tags)
      expect(selectLatestStableReleaseTag(tags)).toBe(expected)
      expect(tags).toEqual(input)
      tags.push('v99.99.99')
      expect(selectLatestStableReleaseTag(tags)).toBe('v99.99.99')
    }
  })
})
