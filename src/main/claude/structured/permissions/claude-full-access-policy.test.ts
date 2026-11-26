import { describe, expect, it } from 'vitest'
import { createClaudeFullAccessPolicy } from './claude-full-access-policy'

const SESSION = 'session-1'

function status(permissionMode: string): string {
  return `${JSON.stringify({ type: 'system', subtype: 'status', session_id: SESSION, permissionMode })}\n`
}

function toolRequest(requestId: string): string {
  return `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Read' } })}\n`
}

describe('createClaudeFullAccessPolicy', () => {
  it('keeps Full access in Plan entered from Full access, like the CLI does', () => {
    const policy = createClaudeFullAccessPolicy(SESSION)
    policy.observe(status('bypassPermissions') + status('plan') + toolRequest('read-in-plan'))

    expect(policy.allows('read-in-plan')).toBe(true)
  })

  it('asks in Plan entered from a mode the user lowered to', () => {
    const policy = createClaudeFullAccessPolicy(SESSION)
    policy.observe(
      status('bypassPermissions') + status('default') + status('plan') + toolRequest('read-in-plan')
    )

    expect(policy.allows('read-in-plan')).toBe(false)
  })

  it('applies Full access again after Plan returns to it, and suspends it in Ask', () => {
    const policy = createClaudeFullAccessPolicy(SESSION)
    policy.observe(
      status('default') +
        status('plan') +
        status('bypassPermissions') +
        toolRequest('after-plan') +
        status('default') +
        toolRequest('in-ask')
    )

    expect(policy.allows('after-plan')).toBe(true)
    expect(policy.allows('in-ask')).toBe(false)
  })
})
