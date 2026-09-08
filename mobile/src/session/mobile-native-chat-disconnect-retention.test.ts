import { describe, expect, it } from 'vitest'
import {
  resolveMobileNativeChatDuringDisconnect,
  type MobileNativeChatDisconnectRetention
} from './mobile-native-chat-disconnect-retention'

const retained: MobileNativeChatDisconnectRetention = {
  hostId: 'host-a',
  worktreeId: 'workspace-a',
  tabId: 'tab-a',
  resolution: {
    agent: 'claude',
    sessionId: 'opaque-session-a',
    transcriptPath: null
  }
}

function resolve(
  overrides: Partial<Parameters<typeof resolveMobileNativeChatDuringDisconnect>[0]> = {}
) {
  return resolveMobileNativeChatDuringDisconnect({
    connected: false,
    hostId: 'host-a',
    worktreeId: 'workspace-a',
    tabId: 'tab-a',
    terminalTabPresent: true,
    chatViewSelected: true,
    currentResolution: null,
    retained,
    ...overrides
  })
}

describe('mobile native chat disconnect retention', () => {
  it('keeps the last chat session for the same selected terminal during a disconnect', () => {
    expect(resolve()).toEqual({
      resolution: retained.resolution,
      retained
    })
  })

  it('keeps the opaque session when only the transient session metadata disappears', () => {
    expect(
      resolve({
        currentResolution: {
          agent: 'claude',
          sessionId: null,
          transcriptPath: null
        }
      }).resolution
    ).toEqual(retained.resolution)
  })

  it('replaces the retained identity when a fresh session is available', () => {
    const result = resolve({
      connected: true,
      currentResolution: {
        agent: 'claude',
        sessionId: 'opaque-session-b',
        transcriptPath: null
      }
    })

    expect(result.resolution?.sessionId).toBe('opaque-session-b')
    expect(result.retained?.resolution.sessionId).toBe('opaque-session-b')
  })

  it('drops retention when a connected snapshot removes the chat session', () => {
    expect(resolve({ connected: true })).toEqual({
      resolution: null,
      retained: null
    })
  })

  it.each([
    { tabId: 'tab-b' },
    { terminalTabPresent: false },
    { chatViewSelected: false },
    { hostId: 'host-b' },
    { worktreeId: 'workspace-b' }
  ])('does not carry a retained target across another scope: %o', (overrides) => {
    expect(resolve(overrides)).toEqual({
      resolution: null,
      retained: null
    })
  })

  it('does not combine a retained session with a different current agent', () => {
    expect(
      resolve({
        currentResolution: {
          agent: 'codex',
          sessionId: null,
          transcriptPath: null
        }
      })
    ).toEqual({
      resolution: {
        agent: 'codex',
        sessionId: null,
        transcriptPath: null
      },
      retained: null
    })
  })
})
