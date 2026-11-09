import { describe, expect, it, vi } from 'vitest'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import { createClaudeNamingGeneration } from './claude-naming-generation'

describe('createClaudeNamingGeneration', () => {
  it("passes a close's options through to the connection it watches", async () => {
    const close = vi.fn(async () => true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: attach and the close wrapper read only close and exitVerdict.
    const connection = {
      close,
      exitVerdict: { root: 'exited' }
    } as unknown as ClaudeStreamJsonConnection
    createClaudeNamingGeneration('chat', undefined, 'native', () => {}).attach(connection)

    await connection.close({ grace: 'brief' })

    expect(close).toHaveBeenCalledWith({ grace: 'brief' })
  })
})
