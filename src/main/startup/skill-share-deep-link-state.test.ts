import { describe, expect, it, vi } from 'vitest'
import { SkillShareDeepLinkState } from './skill-share-deep-link-state'

describe('SkillShareDeepLinkState', () => {
  it('queues a startup share until the renderer consumes it once', () => {
    const state = new SkillShareDeepLinkState()

    expect(state.capture(['orca', 'https://app.orca.dev/skills/share/share_startup'])).toBe(true)
    expect(state.consume()).toBe('share_startup')
    expect(state.consume()).toBeNull()
  })

  it('publishes a later second-instance intent and keeps it for renderer recovery', () => {
    const state = new SkillShareDeepLinkState()
    const publish = vi.fn()

    state.capture(['orca', 'https://app.orca.dev/skills/share/share_first'])
    expect(state.capture(['orca', 'orca://skills/share/share_second'], publish)).toBe(true)

    expect(publish).toHaveBeenCalledWith('share_second')
    expect(state.consume()).toBe('share_second')
  })

  it('ignores untrusted URLs without replacing a pending intent', () => {
    const state = new SkillShareDeepLinkState()
    state.capture(['orca', 'https://app.orca.dev/skills/share/share_safe'])

    expect(state.capture(['orca', 'https://attacker.test/skills/share/share_bad'])).toBe(false)
    expect(state.consume()).toBe('share_safe')
  })
})
