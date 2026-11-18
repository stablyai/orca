// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { claudeLivePermissionMode } from './claude-structured-launch-resolution'

// A permission pick may move a running Claude with a set_permission_mode control request; modes
// that only exist as launch flags must not pretend to apply live (#44021).
describe('claudeLivePermissionMode', () => {
  it('maps the pickable modes onto control-request modes', () => {
    expect(claudeLivePermissionMode('ask')).toBe('default')
    expect(claudeLivePermissionMode('accept-edits')).toBe('acceptEdits')
    expect(claudeLivePermissionMode('auto')).toBe('auto')
  })

  it('leaves own and full-access to their spawn-time handling', () => {
    expect(claudeLivePermissionMode('own')).toBeUndefined()
    expect(claudeLivePermissionMode('full-access')).toBeUndefined()
  })
})
