import { describe, expect, it } from 'vitest'
import {
  highlightMobileDiffLines,
  resolveMobileSyntaxLanguage
} from '../session/mobile-file-syntax'
import { buildGitHubPrFileDiffLines, buildGitHubPrFileDiffPreview } from './github-pr-file-diff'

describe('buildGitHubPrFileDiffLines', () => {
  it('preserves context and marks added and removed lines', () => {
    expect(buildGitHubPrFileDiffLines('one\ntwo\nthree\n', 'one\ntoo\nthree\n')).toEqual([
      {
        key: '0:context:1:1',
        kind: 'context',
        oldLineNumber: 1,
        newLineNumber: 1,
        text: 'one'
      },
      {
        key: '1:removed:2',
        kind: 'removed',
        oldLineNumber: 2,
        text: 'two'
      },
      {
        key: '2:added:2',
        kind: 'added',
        newLineNumber: 2,
        text: 'too'
      },
      {
        key: '3:context:3:3',
        kind: 'context',
        oldLineNumber: 3,
        newLineNumber: 3,
        text: 'three'
      }
    ])
  })

  it('shows added files without a fake empty original line', () => {
    expect(buildGitHubPrFileDiffLines('', 'first\nsecond')).toEqual([
      { key: '0:added:1', kind: 'added', newLineNumber: 1, text: 'first' },
      { key: '1:added:2', kind: 'added', newLineNumber: 2, text: 'second' }
    ])
  })

  it('preserves a terminal lone carriage return like the previous line splitter', () => {
    expect(buildGitHubPrFileDiffLines('', 'line\r')).toEqual([
      { key: '0:added:1', kind: 'added', newLineNumber: 1, text: 'line\r' }
    ])
  })

  it('treats one empty LF line and CRLF line as equal', () => {
    expect(buildGitHubPrFileDiffLines('\n', '\r\n')).toEqual([
      {
        key: '0:context:1:1',
        kind: 'context',
        oldLineNumber: 1,
        newLineNumber: 1,
        text: ''
      }
    ])
  })

  it('keeps all lines for large files without exact diff truncation', () => {
    const original = Array.from({ length: 500 }, (_, index) => `old-${index}`).join('\n')
    const modified = Array.from({ length: 500 }, (_, index) => `new-${index}`).join('\n')

    const lines = buildGitHubPrFileDiffLines(original, modified)

    expect(lines).toHaveLength(1000)
    expect(lines[0]).toMatchObject({ kind: 'removed', oldLineNumber: 1, text: 'old-0' })
    expect(lines.at(-1)).toMatchObject({ kind: 'added', newLineNumber: 500, text: 'new-499' })
  })

  it('builds capped previews while preserving the exact total line count', () => {
    const original = Array.from({ length: 500 }, (_, index) => `old-${index}`).join('\n')
    const modified = Array.from({ length: 500 }, (_, index) => `new-${index}`).join('\n')

    const preview = buildGitHubPrFileDiffPreview(original, modified, 400)

    expect(preview.totalLineCount).toBe(1000)
    expect(preview.lines).toHaveLength(400)
    expect(preview.lines[0]).toMatchObject({ kind: 'removed', oldLineNumber: 1, text: 'old-0' })
    expect(preview.lines.at(-1)).toMatchObject({
      kind: 'removed',
      oldLineNumber: 400,
      text: 'old-399'
    })
  })

  it('counts newline-dense files without materializing discarded line arrays', () => {
    const original = '\n'.repeat(200_000)

    const preview = buildGitHubPrFileDiffPreview(original, 'changed', 3)

    expect(preview.totalLineCount).toBe(200_001)
    expect(preview.lines).toEqual([
      { key: '0:removed:1', kind: 'removed', oldLineNumber: 1, text: '' },
      { key: '1:removed:2', kind: 'removed', oldLineNumber: 2, text: '' },
      { key: '2:removed:3', kind: 'removed', oldLineNumber: 3, text: '' }
    ])
  })

  it('preserves common prefix and suffix rows around a streamed middle diff', () => {
    const originalMiddle = Array.from({ length: 500 }, (_, index) => `old-${index}`)
    const modifiedMiddle = Array.from({ length: 500 }, (_, index) => `new-${index}`)
    const original = ['first', ...originalMiddle, 'last'].join('\r\n')
    const modified = ['first', ...modifiedMiddle, 'last'].join('\r\n')

    const preview = buildGitHubPrFileDiffPreview(original, modified, 1_002)

    expect(preview.totalLineCount).toBe(1_002)
    expect(preview.lines[0]).toMatchObject({ kind: 'context', text: 'first' })
    expect(preview.lines[1]).toMatchObject({ kind: 'removed', text: 'old-0' })
    expect(preview.lines[501]).toMatchObject({ kind: 'added', text: 'new-0' })
    expect(preview.lines.at(-1)).toMatchObject({
      kind: 'context',
      oldLineNumber: 502,
      newLineNumber: 502,
      text: 'last'
    })
  })

  it('can compute the total without retaining preview rows', () => {
    const modified = Array.from({ length: 20 }, (_, index) => `new-${index}`).join('\n')

    const preview = buildGitHubPrFileDiffPreview('', modified, 0)

    expect(preview).toEqual({ lines: [], totalLineCount: 20 })
  })

  it('supports mobile syntax highlighting for rendered PR diff rows', () => {
    const preview = buildGitHubPrFileDiffPreview(
      'const label: string = "Old"',
      'const label: string = "New"'
    )

    const highlighted = highlightMobileDiffLines(
      preview.lines,
      resolveMobileSyntaxLanguage('src/App.tsx')
    )

    expect(highlighted[0]?.segments).toContainEqual({ text: 'const', kind: 'keyword' })
    expect(highlighted[1]?.segments).toContainEqual({ text: '"New"', kind: 'string' })
    expect(highlighted[1]).toMatchObject({ kind: 'added', newLineNumber: 1 })
  })
})
