import { describe, expect, it } from 'vitest'
import { createClaudeFullAccessPolicy } from './claude-full-access-policy'

const status = (mode: string): string =>
  `${JSON.stringify({ type: 'system', subtype: 'status', session_id: 's1', permissionMode: mode })}\n`
const request = (id: string): string =>
  `${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool' } })}\n`

describe('live Full access policy', () => {
  it('auto-allows only after Claude accepted the pick, and only where it ran in Full access', () => {
    const live = createClaudeFullAccessPolicy('s1', true)
    live.observe(request('before-report'))
    live.observe(status('bypassPermissions'))
    live.observe(request('in-full-access'))
    live.observe(status('default'))
    live.observe(request('after-ask'))
    live.observe(status('bypassPermissions'))
    live.observe(request('ungranted'))
    expect(live.allows('ungranted')).toBe(false)
    live.grant()
    expect(live.allows('before-report')).toBe(false)
    expect(live.allows('in-full-access')).toBe(true)
    expect(live.allows('after-ask')).toBe(false)
  })
})
