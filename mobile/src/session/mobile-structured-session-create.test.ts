import { describe, expect, it } from 'vitest'
import {
  mobileStructuredCreateFingerprint,
  showMobileStructuredChatChoice
} from './mobile-structured-session-create'

describe('mobile structured session opt-in', () => {
  it('is invisible without both host and workspace support and only appears for Codex', () => {
    expect(
      showMobileStructuredChatChoice({
        hostCapability: false,
        workspaceSupport: true,
        agent: 'codex'
      })
    ).toBe(false)
    expect(
      showMobileStructuredChatChoice({
        hostCapability: true,
        workspaceSupport: false,
        agent: 'codex'
      })
    ).toBe(false)
    expect(
      showMobileStructuredChatChoice({
        hostCapability: true,
        workspaceSupport: true,
        agent: 'claude'
      })
    ).toBe(false)
    expect(
      showMobileStructuredChatChoice({
        hostCapability: true,
        workspaceSupport: true,
        agent: 'codex'
      })
    ).toBe(true)
  })

  it('matches the canonical create-by-intent fingerprint', () => {
    expect(
      mobileStructuredCreateFingerprint({ sessionId: 'session-alpha', worktree: 'id:wt-1' })
    ).toBe('d1e7f0b14cbd06c4740e671fc6a230c66a1e4451c970aab7953f4f150bd107bb')
  })
})
