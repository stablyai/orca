import { describe, expect, it } from 'vitest'
import { SkillCloudRequestError } from './skill-cloud-request-error'
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
})
