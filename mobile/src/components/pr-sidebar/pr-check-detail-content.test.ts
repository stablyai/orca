import { describe, expect, it } from 'vitest'
import type { PRCheckRunDetails } from '../../../../src/shared/types'
import { presentCheckDetail } from './pr-check-detail-content'

function details(over: Partial<PRCheckRunDetails>): PRCheckRunDetails {
  return {
    name: 'ci',
    status: 'completed',
    conclusion: 'failure',
    url: null,
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    title: null,
    summary: null,
    text: null,
    annotations: [],
    jobs: [],
    ...over
  }
}

describe('presentCheckDetail', () => {
  it('builds summary lines from conclusion/title/summary, skipping blanks', () => {
    const content = presentCheckDetail(
      details({ conclusion: 'failure', title: 'Build failed', summary: '   ' })
    )
    expect(content.summaryLines).toEqual(['failure', 'Build failed'])
  })

  it('maps annotations with a path:line locator and caps at 20', () => {
    const content = presentCheckDetail(
      details({
        annotations: Array.from({ length: 25 }, (_, index) => ({
          path: `src/file${index}.ts`,
          startLine: index + 1,
          endLine: null,
          annotationLevel: 'failure',
          title: null,
          message: `problem ${index}`,
          rawDetails: null
        }))
      })
    )
    expect(content.annotations).toHaveLength(20)
    expect(content.annotationsTruncated).toBe(true)
    expect(content.annotations[0]).toMatchObject({
      locator: 'src/file0.ts:1',
      level: 'failure',
      message: 'problem 0'
    })
  })

  it('falls back to "Annotation" when no path is present', () => {
    const content = presentCheckDetail(
      details({
        annotations: [
          {
            path: null,
            startLine: null,
            endLine: null,
            annotationLevel: null,
            title: null,
            message: 'no path',
            rawDetails: null
          }
        ]
      })
    )
    expect(content.annotations[0].locator).toBe('Annotation')
  })

  it('prefers failing jobs and surfaces only their failed steps', () => {
    const content = presentCheckDetail(
      details({
        jobs: [
          {
            id: 1,
            name: 'passing-job',
            status: 'completed',
            conclusion: 'success',
            startedAt: null,
            completedAt: null,
            url: null,
            logTail: null,
            steps: []
          },
          {
            id: 2,
            name: 'failing-job',
            status: 'completed',
            conclusion: 'failure',
            startedAt: null,
            completedAt: null,
            url: null,
            logTail: 'error: boom',
            steps: [
              {
                name: 'ok-step',
                status: 'completed',
                conclusion: 'success',
                startedAt: null,
                completedAt: null
              },
              {
                name: 'bad-step',
                status: 'completed',
                conclusion: 'failure',
                startedAt: null,
                completedAt: null
              }
            ]
          }
        ]
      })
    )
    expect(content.jobsLabel).toBe('Failed jobs')
    expect(content.jobs).toHaveLength(1)
    expect(content.jobs[0]).toMatchObject({ name: 'failing-job', logTail: 'error: boom' })
    expect(content.jobs[0].failedSteps).toEqual([{ name: 'bad-step', state: 'failure' }])
  })

  it('shows all jobs labeled "Jobs" when none are failing', () => {
    const content = presentCheckDetail(
      details({
        conclusion: 'success',
        jobs: [
          {
            id: 1,
            name: 'a',
            status: 'completed',
            conclusion: 'success',
            startedAt: null,
            completedAt: null,
            url: null,
            logTail: null,
            steps: []
          }
        ]
      })
    )
    expect(content.jobsLabel).toBe('Jobs')
    expect(content.jobs).toHaveLength(1)
  })
})
