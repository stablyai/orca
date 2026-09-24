import { describe, expect, it } from 'vitest'
import { mapClangdLocationResult } from './clangd-protocol'

const toPath = (uri: string): string => uri

describe('mapClangdLocationResult', () => {
  it('maps an array of locations to semantic locations', () => {
    const result = mapClangdLocationResult(
      [
        {
          uri: 'file:///D:/a.hpp',
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }
        },
        {
          uri: 'file:///D:/b.cpp',
          range: { start: { line: 8, character: 0 }, end: { line: 8, character: 3 } }
        }
      ],
      toPath
    )
    expect(result).toEqual([
      {
        path: 'file:///D:/a.hpp',
        range: { startLine: 1, startCharacter: 2, endLine: 1, endCharacter: 5 }
      },
      {
        path: 'file:///D:/b.cpp',
        range: { startLine: 8, startCharacter: 0, endLine: 8, endCharacter: 3 }
      }
    ])
  })

  it('normalizes a bare single Location object (not an array) to a one-element list', () => {
    const result = mapClangdLocationResult(
      {
        uri: 'file:///D:/a.hpp',
        range: { start: { line: 4, character: 6 }, end: { line: 4, character: 9 } }
      },
      toPath
    )
    expect(result).toEqual([
      {
        path: 'file:///D:/a.hpp',
        range: { startLine: 4, startCharacter: 6, endLine: 4, endCharacter: 9 }
      }
    ])
  })

  it('returns an empty list for a null result (symbol with no references/declaration)', () => {
    expect(mapClangdLocationResult(null, toPath)).toEqual([])
    expect(mapClangdLocationResult(undefined, toPath)).toEqual([])
    expect(mapClangdLocationResult([], toPath)).toEqual([])
  })

  it('skips malformed items missing uri or range endpoints', () => {
    const result = mapClangdLocationResult(
      [
        {
          uri: 'file:///D:/ok.hpp',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
        },
        { uri: 'file:///D:/no-range.hpp' },
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
        { uri: 'file:///D:/partial.hpp', range: { start: { line: 0, character: 0 } } }
      ],
      toPath
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe('file:///D:/ok.hpp')
  })
})
