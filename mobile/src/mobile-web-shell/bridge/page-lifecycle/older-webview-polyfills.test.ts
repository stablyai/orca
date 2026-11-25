import { describe, expect, it } from 'vitest'
import {
  arrayPolyfills,
  mapGroupBy,
  objectGroupBy,
  promiseWithResolvers,
  setPolyfills,
  urlCanParse
} from './older-webview-polyfills'

// Node ships every one of these natively, so each polyfill is checked against the real built-in.
describe('older WebView polyfills match the built-ins', () => {
  const source = [3, 1, 2, 5, 4]

  it('copies arrays like the native copy methods', () => {
    const compare = (a: number, b: number) => a - b
    expect(arrayPolyfills.toSorted.call(source, compare)).toEqual(source.toSorted(compare))
    expect(arrayPolyfills.toSorted.call(source)).toEqual(source.toSorted())
    expect(arrayPolyfills.toReversed.call(source)).toEqual(source.toReversed())
    const toSpliced = (...args: [number?, number?, ...number[]]) =>
      arrayPolyfills.toSpliced.call(source, ...args)
    // The native typings have no zero- or one-argument overload; those two use the spec's results.
    expect(toSpliced()).toEqual(source)
    expect(toSpliced(1)).toEqual([3])
    expect(toSpliced(1, 2)).toEqual(source.toSpliced(1, 2))
    expect(toSpliced(-2, 1, 9, 8)).toEqual(source.toSpliced(-2, 1, 9, 8))
    expect(toSpliced(10, 1, 7)).toEqual(source.toSpliced(10, 1, 7))
    expect(toSpliced(-10, 2)).toEqual(source.toSpliced(-10, 2))
    expect(toSpliced(2, -1, 6)).toEqual(source.toSpliced(2, -1, 6))
    expect(arrayPolyfills.with.call(source, 1, 9)).toEqual(source.with(1, 9))
    expect(arrayPolyfills.with.call(source, -1, 9)).toEqual(source.with(-1, 9))
    expect(() => arrayPolyfills.with.call(source, 5, 9)).toThrow(RangeError)
    expect(() => arrayPolyfills.with.call(source, -6, 9)).toThrow(RangeError)
    expect(source).toEqual([3, 1, 2, 5, 4])
  })

  it('combines sets like the native set methods', () => {
    const left = new Set([1, 2, 3])
    const right = new Set([2, 3, 4])
    for (const name of ['union', 'intersection', 'difference', 'symmetricDifference'] as const) {
      expect([...setPolyfills[name].call(left, right)]).toEqual([...left[name](right)])
    }
    for (const name of ['isSubsetOf', 'isSupersetOf', 'isDisjointFrom'] as const) {
      for (const other of [right, new Set([1, 2]), new Set([1, 2, 3, 4]), new Set([9])]) {
        expect(setPolyfills[name].call(left, other)).toBe(left[name](other))
      }
    }
  })

  it('groups like Map.groupBy and Object.groupBy', () => {
    const words = ['ant', 'bee', 'cat', 'bear', 'cow']
    const firstLetter = (word: string) => word[0]
    expect([...mapGroupBy(words, firstLetter)]).toEqual([...Map.groupBy(words, firstLetter)])
    expect(objectGroupBy(words, firstLetter)).toEqual(Object.groupBy(words, firstLetter))
    expect(Object.getPrototypeOf(objectGroupBy(words, firstLetter))).toBeNull()
    const mixedKey = (value: number) => (value % 2 === 0 ? 1 : '1')
    expect(objectGroupBy([1, 2, 3], mixedKey)).toEqual(Object.groupBy([1, 2, 3], mixedKey))
  })

  it('parses like URL.canParse', () => {
    const cases: [string, string?][] = [
      ['https://example.com/a'],
      ['not a url'],
      ['/relative'],
      ['/relative', 'https://example.com'],
      ['http:example.com'],
      ['', 'https://example.com/x']
    ]
    for (const [url, base] of cases) {
      expect(urlCanParse(url, base)).toBe(URL.canParse(url, base))
    }
  })

  it('settles like Promise.withResolvers', async () => {
    const resolved = promiseWithResolvers<number>()
    resolved.resolve(7)
    await expect(resolved.promise).resolves.toBe(7)
    const rejected = promiseWithResolvers<number>()
    rejected.reject(new Error('no'))
    await expect(rejected.promise).rejects.toThrow('no')
  })
})
