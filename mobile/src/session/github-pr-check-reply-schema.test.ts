import { describe, expect, it } from 'vitest'
import { githubPrCheckDetailsSchema } from './github-pr-check-reply-schema'

describe('optional job log outcome', () => {
  it.each(['available', 'empty', 'error', 'not_requested'])(
    'preserves %s and job metadata',
    (logState) => {
      const result = githubPrCheckDetailsSchema.parse({
        name: 'check',
        jobs: [{ id: 1, name: 'job', logTail: 'excerpt', logState, steps: [{ name: 'step' }] }]
      })
      expect(result?.jobs[0]).toMatchObject({
        id: 1,
        name: 'job',
        logTail: 'excerpt',
        logState,
        steps: [{ name: 'step' }]
      })
    }
  )
  it.each([undefined, null, 'future', 3, {}, ['error']])(
    'salvages unknown outcome %j without losing the job',
    (logState) => {
      const result = githubPrCheckDetailsSchema.parse({
        name: 'check',
        jobs: [{ id: 1, name: 'job', logTail: 'excerpt', logState }]
      })
      expect(result?.jobs[0]).toMatchObject({ id: 1, name: 'job', logTail: 'excerpt' })
      expect(result?.jobs[0]).not.toHaveProperty('logState')
    }
  )
})
