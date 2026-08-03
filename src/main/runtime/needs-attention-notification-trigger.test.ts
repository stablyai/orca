import { describe, expect, it } from 'vitest'
import { shouldNotifyNeedsAttentionChange } from './needs-attention-notification-trigger'

describe('shouldNotifyNeedsAttentionChange', () => {
  it('notifies when a reason is newly set from null', () => {
    expect(shouldNotifyNeedsAttentionChange(null, 'PR #996: 1 unresolved thread')).toBe(true)
  })

  it('notifies when a reason is newly set from undefined', () => {
    expect(shouldNotifyNeedsAttentionChange(undefined, 'PR #996: 1 unresolved thread')).toBe(true)
  })

  it('notifies when the reason text changes', () => {
    expect(shouldNotifyNeedsAttentionChange('1 unresolved thread', '2 unresolved threads')).toBe(
      true
    )
  })

  it('does not notify when the reason is unchanged', () => {
    expect(shouldNotifyNeedsAttentionChange('same reason', 'same reason')).toBe(false)
  })

  it('does not notify on a clear', () => {
    expect(shouldNotifyNeedsAttentionChange('was set', null)).toBe(false)
  })

  it('does not notify when the field was never sent', () => {
    expect(shouldNotifyNeedsAttentionChange('was set', undefined)).toBe(false)
  })

  it('does not notify on an empty string', () => {
    expect(shouldNotifyNeedsAttentionChange(null, '')).toBe(false)
  })
})
