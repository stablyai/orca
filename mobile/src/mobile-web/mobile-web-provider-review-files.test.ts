import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_PROVIDER_REVIEW_FILE_LIMIT,
  MOBILE_WEB_PROVIDER_REVIEW_FILE_LINE_LIMIT,
  MOBILE_WEB_PROVIDER_REVIEW_TOTAL_LINE_LIMIT
} from '../../../src/shared/mobile-web/provider-review-contract'
import { sanitizeMobileWebProviderReviewFiles } from './mobile-web-provider-review-files'

describe('mobile web provider review files', () => {
  it('bounds retained files, per-file lines, and aggregate lines', () => {
    const files = Array.from({ length: MOBILE_WEB_PROVIDER_REVIEW_FILE_LIMIT + 2 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      status: 'modified',
      additions: 300,
      deletions: 0,
      isBinary: false,
      reviewCommentLineNumbers: Array.from(
        { length: MOBILE_WEB_PROVIDER_REVIEW_FILE_LINE_LIMIT + 10 },
        (_entry, line) => line + 1
      )
    }))

    const result = sanitizeMobileWebProviderReviewFiles('github', files)

    expect(result.items).toHaveLength(MOBILE_WEB_PROVIDER_REVIEW_FILE_LIMIT)
    expect(result.truncated).toBe(true)
    expect(result.items[0]).toMatchObject({
      commentableLinesTruncated: true,
      commentableLines: expect.arrayContaining([1, MOBILE_WEB_PROVIDER_REVIEW_FILE_LINE_LIMIT])
    })
    expect(result.items.reduce((total, file) => total + file.commentableLines.length, 0)).toBe(
      MOBILE_WEB_PROVIDER_REVIEW_TOTAL_LINE_LIMIT
    )
  })

  it('drops unsafe paths and derives only modified-side GitLab lines', () => {
    const result = sanitizeMobileWebProviderReviewFiles('gitlab', [
      {
        path: '../escape.ts',
        status: 'modified',
        diff: '@@ -1 +1 @@\n-old\n+new'
      },
      {
        path: 'src/review.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        isBinary: false,
        diff: '@@ -20,2 +20,3 @@\n context\n-old\n+new\n next'
      }
    ])

    expect(result).toEqual({
      items: [
        {
          path: 'src/review.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          isBinary: false,
          commentableLines: [20, 21, 22],
          commentableLinesTruncated: false
        }
      ],
      truncated: true
    })
  })
})
