import { prChecksSchema } from './github-pr-entity-reply-schema'
import { detailCheckListSchema } from '../tasks/task-provider-entity-reply-schema'
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

it('preserves only immutable optional row identity through both existing readers without losing old or malformed rows', () => {
  const payload = JSON.parse(
    JSON.stringify([
      {
        name: 'proved',
        status: 'completed',
        conclusion: 'action_required',
        observedHeadSha: 'a'.repeat(40)
      },
      { name: 'legacy', status: 'completed', conclusion: 'success' },
      { name: 'malformed', status: 'completed', conclusion: 'success', observedHeadSha: 'branch' }
    ])
  )
  for (const schema of [prChecksSchema, detailCheckListSchema]) {
    const checks = schema.parse(payload)
    expect(checks).toHaveLength(3)
    expect(checks[0]).toMatchObject({ name: 'proved', observedHeadSha: 'a'.repeat(40) })
    expect(checks[1].observedHeadSha).toBeUndefined()
    expect(checks[2].observedHeadSha).toBeUndefined()
  }
})
