import { describe, expect, it } from 'vitest'
import type { AgentProviderSessionMetadata } from '../../../src/shared/agent-session-resume'
import {
  NO_MOBILE_PROVIDER_SESSIONS,
  rememberMobileProviderSession
} from './mobile-structured-provider-session'

const CLAUDE: AgentProviderSessionMetadata = { key: 'session_id', id: 'claude-1' }

describe('mobile provider sessions', () => {
  it('keeps the provider session a history read named', () => {
    const kept = rememberMobileProviderSession(NO_MOBILE_PROVIDER_SESSIONS, 'chat-1', CLAUDE)

    expect(kept.get('chat-1')).toEqual(CLAUDE)
  })

  it('keeps the previous value when a later read names none', () => {
    const kept = rememberMobileProviderSession(NO_MOBILE_PROVIDER_SESSIONS, 'chat-1', CLAUDE)

    expect(rememberMobileProviderSession(kept, 'chat-1', undefined)).toBe(kept)
  })

  it('leaves the map alone for a report it already holds', () => {
    const kept = rememberMobileProviderSession(NO_MOBILE_PROVIDER_SESSIONS, 'chat-1', CLAUDE)

    expect(rememberMobileProviderSession(kept, 'chat-1', { ...CLAUDE })).toBe(kept)
  })

  it('replaces an entry whose transcript path arrived later', () => {
    const kept = rememberMobileProviderSession(NO_MOBILE_PROVIDER_SESSIONS, 'chat-1', CLAUDE)

    const named = rememberMobileProviderSession(kept, 'chat-1', {
      ...CLAUDE,
      transcriptPath: '/tmp/claude-1.jsonl'
    })

    expect(named.get('chat-1')?.transcriptPath).toBe('/tmp/claude-1.jsonl')
  })

  it('drops the oldest chat rather than growing for the app lifetime', () => {
    let kept = NO_MOBILE_PROVIDER_SESSIONS
    for (let index = 0; index < 33; index += 1) {
      kept = rememberMobileProviderSession(kept, `chat-${index}`, {
        key: 'session_id',
        id: `id-${index}`
      })
    }

    expect(kept.size).toBe(32)
    expect(kept.has('chat-0')).toBe(false)
    expect(kept.has('chat-32')).toBe(true)
  })
})
