import { describe, expect, it } from 'vitest'
import {
  createAutomationDispatchToken,
  getAutomationDispatchTokenCountForTests,
  MAX_AUTOMATION_DISPATCH_TOKENS
} from './dispatch-tokens'

describe('automation dispatch tokens', () => {
  it('bounds distinct token churn', () => {
    for (let index = 0; index < MAX_AUTOMATION_DISPATCH_TOKENS + 4; index += 1) {
      createAutomationDispatchToken(`automation-${index}`, `run-${index}`)
    }

    expect(getAutomationDispatchTokenCountForTests()).toBe(MAX_AUTOMATION_DISPATCH_TOKENS)
  })
})
