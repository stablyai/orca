import { describe, expect, it } from 'vitest'
import {
  mobileStructuredCreateFingerprint,
  showMobileStructuredChatChoice
} from './mobile-structured-session-create'

describe('mobile structured session opt-in', () => {
  it('is invisible without both host and workspace support and appears for supported agents', () => {
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
    ).toBe(true)
    expect(
      showMobileStructuredChatChoice({
        hostCapability: true,
        workspaceSupport: true,
        agent: 'codex'
      })
    ).toBe(true)
    expect(
      showMobileStructuredChatChoice({
        hostCapability: true,
        workspaceSupport: true,
        agent: 'openclaude'
      })
    ).toBe(false)
  })

  it('matches the canonical provider-specific create-by-intent fingerprints', () => {
    expect(
      mobileStructuredCreateFingerprint({
        sessionId: 'session-alpha',
        worktree: 'id:wt-1',
        agent: 'codex'
      })
    ).toBe('d1e7f0b14cbd06c4740e671fc6a230c66a1e4451c970aab7953f4f150bd107bb')
    expect(
      mobileStructuredCreateFingerprint({
        sessionId: 'session-alpha',
        worktree: 'id:wt-1',
        agent: 'claude'
      })
    ).toBe('def924b21a560c7db39794649f52ffdd475b53d9e04200e8d7d01c3074e606aa')
  })
})
