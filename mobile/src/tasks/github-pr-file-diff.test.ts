import { describe, expect, it } from 'vitest'

import { buildGitHubPrFileDiffLines, buildGitHubPrFileDiffPreview } from './github-pr-file-diff'

describe('buildGitHubPrFileDiffLines', () => {
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
})
