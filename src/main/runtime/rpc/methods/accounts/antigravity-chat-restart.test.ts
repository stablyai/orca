import { expect, it, vi } from 'vitest'
import type { AntigravityChatAuthConfig } from '../../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'

const host = vi.hoisted((): { released: string[]; synced: unknown[] } => ({
  released: [],
  synced: []
}))
vi.mock('../../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/data'
}))
vi.mock('../../../../antigravity/antigravity-chat-agy-login-copy', () => ({
  syncAgyLoginCopy: async (saved: unknown, data: string) => {
    host.synced.push([saved, data])
  }
}))
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => ({
      loadedSessionIds: () => ['agy-home', 'orca-home', 'other-agent'],
      sessionAgent: (id: string) => (id === 'other-agent' ? 'codex' : 'antigravity'),
      childAccountHome: (id: string) =>
        id === 'agy-home'
          ? { variable: 'GEMINI_HOME', path: '/home/u/.gemini' }
          : { variable: 'GEMINI_HOME', path: '/data/antigravity-chat' },
      releaseIdleSession: async (id: string) => {
        host.released.push(id)
      }
    })
  })
)

import { restartIdleAgyChats } from './antigravity-chat-backend'

function restart(antigravityChatAuth: AntigravityChatAuthConfig): string[] {
  host.released = []
  host.synced = []
  restartIdleAgyChats(
    { runtime: 'host' },
    { requireStore: () => ({ getSettings: () => ({ antigravityChatAuth }) }) }
  )
  return host.released
}

it("restarts Orca's chat home too when its chats sign in with agy's Google login", () => {
  expect(restart({ method: 'oauth-personal' })).toEqual(['agy-home', 'orca-home'])
})

it("leaves Orca's chat home running on a key, which an agy account switch doesn't touch", () => {
  expect(restart({ method: 'gemini-api-key' })).toEqual(['agy-home'])
})

it("brings the chat home's copy of agy's login in line on every switch or removal", () => {
  restart({ method: 'oauth-personal' })
  expect(host.synced).toEqual([[{ method: 'oauth-personal' }, '/data']])
})
