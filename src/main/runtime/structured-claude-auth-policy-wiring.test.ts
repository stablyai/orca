import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_STRUCTURED_AUTH_POLICY_REQUIRED,
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

/** The structured host's Claude auth policy has exactly one production wiring; without it a
 *  failed sign-in would silently name the wrong login. */
describe('structured Claude auth policy wiring', () => {
  describe('installing without one', () => {
    let stateDirectory: string | null = null

    afterEach(async () => {
      await stopStructuredAgentSessionRuntime()
      if (stateDirectory) {
        await rm(stateDirectory, { recursive: true, force: true })
        stateDirectory = null
      }
    })

    it('refuses loudly rather than defaulting to a guess', async () => {
      stateDirectory = await mkdtemp(join(tmpdir(), 'orca-auth-policy-wiring-'))

      await expect(
        ensureStructuredAgentSessionHost({
          stateDirectory,
          hostId: 'local',
          claimKeyId: 'key-1',
          resolveWorkspacePath: async () => stateDirectory as string
        } as unknown as Parameters<typeof ensureStructuredAgentSessionHost>[0])
      ).rejects.toThrow(CLAUDE_STRUCTURED_AUTH_POLICY_REQUIRED)
    })
  })
})
