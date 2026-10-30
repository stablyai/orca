import { describe, expect, it, vi } from 'vitest'
import type { MobileSyntaxSegment } from '../session/mobile-file-syntax'

vi.mock('react-native', () => ({
  StyleSheet: { create: (value: unknown) => value }
}))

import { splitSyntaxSegmentsIntoLines } from './MobileFilePreviewSourceText'

describe('splitSyntaxSegmentsIntoLines', () => {
  it('splits single plain segment into lines', () => {
    const segments: MobileSyntaxSegment[] = [
      { text: 'line 1\nline 2\nline 3', kind: 'plain' }
    ]
    const lines = splitSyntaxSegmentsIntoLines(segments)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toEqual([{ text: 'line 1', kind: 'plain' }])
    expect(lines[1]).toEqual([{ text: 'line 2', kind: 'plain' }])
    expect(lines[2]).toEqual([{ text: 'line 3', kind: 'plain' }])
  })

  it('handles multi-segment lines correctly', () => {
    const segments: MobileSyntaxSegment[] = [
      { text: 'const ', kind: 'keyword' },
      { text: 'foo', kind: 'variable' },
      { text: ' = ', kind: 'plain' },
      { text: '1\nconst ', kind: 'keyword' },
      { text: 'bar', kind: 'variable' }
    ]
    const lines = splitSyntaxSegmentsIntoLines(segments)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual([
      { text: 'const ', kind: 'keyword' },
      { text: 'foo', kind: 'variable' },
      { text: ' = ', kind: 'plain' },
      { text: '1', kind: 'keyword' }
    ])
    expect(lines[1]).toEqual([
      { text: 'const ', kind: 'keyword' },
      { text: 'bar', kind: 'variable' }
    ])
  })

  it('handles empty lines and trailing newlines', () => {
    const segments: MobileSyntaxSegment[] = [{ text: 'first\n\nlast\n', kind: 'plain' }]
    const lines = splitSyntaxSegmentsIntoLines(segments)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toEqual([{ text: 'first', kind: 'plain' }])
    expect(lines[1]).toEqual([])
    expect(lines[2]).toEqual([{ text: 'last', kind: 'plain' }])
    expect(lines[3]).toEqual([])
  })
})
