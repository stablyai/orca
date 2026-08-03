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
