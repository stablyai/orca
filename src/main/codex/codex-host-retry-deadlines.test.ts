import { describe, expect, it } from 'vitest'
import {
  MAX_CODEX_APP_SERVER_CAPABILITY_HOSTS,
  type CodexAppServerHostKey
} from './codex-app-server-capability-cache'
import { CodexHostRetryDeadlines } from './codex-host-retry-deadlines'

function host(index: number): CodexAppServerHostKey {
  return `wsl:distro-${index}`
}

describe('CodexHostRetryDeadlines', () => {
  it('preserves every deadline through the exact host limit', () => {
    const deadlines = new CodexHostRetryDeadlines()
    for (let index = 0; index < MAX_CODEX_APP_SERVER_CAPABILITY_HOSTS; index += 1) {
      deadlines.set(host(index), index + 1)
    }

    expect(deadlines.sizeForTest()).toBe(MAX_CODEX_APP_SERVER_CAPABILITY_HOSTS)
    for (let index = 0; index < MAX_CODEX_APP_SERVER_CAPABILITY_HOSTS; index += 1) {
      expect(deadlines.get(host(index))).toBe(index + 1)
    }
  })

  it('evicts the least recently used host above the limit', () => {
    const deadlines = new CodexHostRetryDeadlines()
    for (let index = 0; index < MAX_CODEX_APP_SERVER_CAPABILITY_HOSTS; index += 1) {
      deadlines.set(host(index), index + 1)
    }
    expect(deadlines.get(host(0))).toBe(1)

    deadlines.set(host(MAX_CODEX_APP_SERVER_CAPABILITY_HOSTS), 999)

    expect(deadlines.sizeForTest()).toBe(MAX_CODEX_APP_SERVER_CAPABILITY_HOSTS)
    expect(deadlines.get(host(0))).toBe(1)
    expect(deadlines.get(host(1))).toBeUndefined()
    expect(deadlines.get(host(MAX_CODEX_APP_SERVER_CAPABILITY_HOSTS))).toBe(999)
  })
})
