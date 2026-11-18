import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { InitializeResponseSchema } from '../acp/generated/acp-protocol.generated'
import { antigravityTakesSystemPrompt } from '../acp/launch/acp-instructions'
import { ANTIGRAVITY_ACP_VERSION } from './antigravity-acp-runtime'

describe('the pinned Antigravity server', () => {
  // Recorded from the pinned release; a new pin needs a new recording, which must still advertise it.
  it("advertises the system-prompt channel a bot's instructions take", async () => {
    const recorded = InitializeResponseSchema.parse(
      JSON.parse(
        await readFile(
          new URL('../acp/fixtures/antigravity-v1.5.0-initialize.json', import.meta.url),
          'utf8'
        )
      )
    )
    expect(recorded.agentInfo?.version).toBe(ANTIGRAVITY_ACP_VERSION)
    expect(antigravityTakesSystemPrompt(recorded)).toBe(true)
  })
})
