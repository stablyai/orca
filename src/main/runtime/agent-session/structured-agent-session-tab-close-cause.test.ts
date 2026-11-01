import { describe, expect, it } from 'vitest'
import { structuredAgentSessionTabCloseCause } from './structured-agent-session-tab-close-cause'

describe('structuredAgentSessionTabCloseCause', () => {
  it.each([
    { label: "an older client's reasonless close", reason: undefined, cause: 'user-close' },
    { label: 'a user close', reason: 'user', cause: 'user-close' },
    { label: 'a cleanup echo', reason: 'cleanup', cause: 'evict' },
    { label: 'a pty-exit echo', reason: 'pty-exit', cause: 'evict' }
  ] as const)('closes the chat with $cause for $label', ({ reason, cause }) => {
    expect(structuredAgentSessionTabCloseCause(reason)).toBe(cause)
  })
})
