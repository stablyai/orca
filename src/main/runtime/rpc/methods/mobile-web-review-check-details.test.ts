import { describe, expect, it } from 'vitest'
import { clipMobileWebReviewCheckDetails } from './mobile-web-review-check-details'

describe('review check details byte budget', () => {
  it('bounds escaped annotations even when there are no jobs to drop', () => {
    const details = clipMobileWebReviewCheckDetails({
      name: 'build',
      url: null,
      detailsUrl: null,
      text: null,
      status: null,
      conclusion: null,
      startedAt: null,
      completedAt: null,
      title: null,
      summary: '\u0001'.repeat(16 * 1024),
      annotations: Array.from({ length: 20 }, () => ({
        path: 'src/app.ts',
        startLine: 1,
        endLine: 1,
        annotationLevel: 'failure',
        title: null,
        message: '\u0001'.repeat(8 * 1024),
        rawDetails: null
      })),
      jobs: []
    })
    expect(Buffer.byteLength(JSON.stringify(details))).toBeLessThanOrEqual(256 * 1024)
    expect(details!.annotations.length).toBeLessThan(20)
  })

  it('drops a single job that cannot fit the remaining budget', () => {
    const details = clipMobileWebReviewCheckDetails({
      name: 'build',
      url: null,
      detailsUrl: null,
      text: null,
      status: null,
      conclusion: null,
      startedAt: null,
      completedAt: null,
      title: null,
      summary: '\u0001'.repeat(16 * 1024),
      annotations: [],
      jobs: [
        {
          id: 1,
          name: 'job',
          startedAt: null,
          completedAt: null,
          url: null,
          status: null,
          conclusion: null,
          logTail: '\u0001'.repeat(32 * 1024),
          steps: []
        }
      ]
    })
    expect(Buffer.byteLength(JSON.stringify(details))).toBeLessThanOrEqual(256 * 1024)
    expect(details!.jobs).toEqual([])
  })
})
