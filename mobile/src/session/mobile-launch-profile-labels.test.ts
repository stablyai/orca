import { describe, expect, it } from 'vitest'
import { mobileLaunchProfileBadge } from './mobile-launch-profile-labels'

describe('mobileLaunchProfileBadge', () => {
  it('shortens built-in labels to their distinguishing half', () => {
    expect(mobileLaunchProfileBadge('codex-secondary-home')).toBe('secondary home')
    expect(mobileLaunchProfileBadge('claude-secondary-home')).toBe('secondary home')
  })

  it('shows custom ids as-is and nothing for a default launch', () => {
    expect(mobileLaunchProfileBadge('codex-work-proxy')).toBe('codex-work-proxy')
    expect(mobileLaunchProfileBadge(undefined)).toBeNull()
    expect(mobileLaunchProfileBadge(' ')).toBeNull()
  })
})
