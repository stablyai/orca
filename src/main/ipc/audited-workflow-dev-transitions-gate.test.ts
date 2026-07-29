import { describe, expect, it } from 'vitest'
import { shouldRegisterAuditedWorkflowDevTransitions } from './audited-workflow-dev-transitions-gate'

describe('shouldRegisterAuditedWorkflowDevTransitions', () => {
  it('is false when the app is packaged (production gate — plan §15 item 10)', () => {
    expect(shouldRegisterAuditedWorkflowDevTransitions(true)).toBe(false)
  })

  it('is true when the app is not packaged (dev builds only)', () => {
    expect(shouldRegisterAuditedWorkflowDevTransitions(false)).toBe(true)
  })
})
