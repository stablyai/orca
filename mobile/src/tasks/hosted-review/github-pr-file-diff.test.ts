import { describe, expect, it } from 'vitest'

import { buildGitHubPrFileDiffPreview } from './github-pr-file-diff'

describe('buildGitHubPrFileDiffPreview', () => {
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
