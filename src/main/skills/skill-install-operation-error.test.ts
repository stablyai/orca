import { describe, expect, it } from 'vitest'
import { SkillCloudRequestError } from './skill-cloud-request'
import { skillInstallFailureFromError } from './skill-install-operation-error'

describe('skillInstallFailureFromError', () => {
  it('reports a rejected cloud request as transport, not filesystem', () => {
    const error = new SkillCloudRequestError(
      409,
      'package_name_taken',
      'The skill package request failed.'
    )
    expect(skillInstallFailureFromError(error)).toEqual({
      category: 'transport',
      code: 'skill-cloud-request-failed',
      retryable: false
    })
  })

  it('keeps a server-side cloud failure retryable', () => {
    const error = new SkillCloudRequestError(503, 'unavailable', 'unavailable')
    expect(skillInstallFailureFromError(error)?.retryable).toBe(true)
  })

  it('still maps a real filesystem errno', () => {
    const error = Object.assign(new Error('boom'), { code: 'EBUSY' })
    expect(skillInstallFailureFromError(error)).toEqual({
      category: 'filesystem',
      code: 'skill-install-filesystem-failed',
      retryable: true
    })
  })
})
