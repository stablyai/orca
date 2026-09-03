import { describe, expect, it } from 'vitest'
import { buildNotificationOptions } from './notification-options'

describe('buildNotificationOptions', () => {
  it('shows the opaque needs-attention reason verbatim in the body', () => {
    const options = buildNotificationOptions({
      source: 'needs-attention',
      worktreeLabel: 'my-feature',
      needsAttentionReason: 'PR #996: 1 unresolved thread'
    })

    expect(options.title).toBe('Needs attention: my-feature')
    expect(options.body).toBe('PR #996: 1 unresolved thread')
  })

  it('falls back to a generic title when no worktree label is known', () => {
    const options = buildNotificationOptions({
      source: 'needs-attention',
      needsAttentionReason: 'reason'
    })

    expect(options.title).toBe('Needs attention: workspace')
  })

  it('falls back to a generic body when the reason is blank', () => {
    const options = buildNotificationOptions({
      source: 'needs-attention',
      worktreeLabel: 'my-feature',
      needsAttentionReason: ''
    })

    expect(options.body).toBe('A worktree needs your attention.')
  })

  it('truncates a very long reason for the notification body', () => {
    const longReason = 'x'.repeat(300)
    const options = buildNotificationOptions({
      source: 'needs-attention',
      worktreeLabel: 'my-feature',
      needsAttentionReason: longReason
    })

    expect(options.body.length).toBeLessThan(longReason.length)
    expect(options.body.endsWith('…')).toBe(true)
  })
})
