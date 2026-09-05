import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_STRUCTURED_AUTH_POLICY_REQUIRED,
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

/**
 * The structured host's Claude auth policy has exactly one production wiring, and it
 * lives in `orca-runtime-get-worktree-ps.ts` — a `@ts-nocheck` file, so neither the
 * compiler nor a type test can see the field disappear. Deleting that wiring used to
 * leave ~1000 tests green while every `ANTHROPIC_*` variable in the shell reached the
 * child, because `stripAuthEnv` silently fell back to `false`.
 *
 * Two independent guards replace that silence, and this file pins both.
 */
describe('structured Claude auth policy wiring', () => {
  // The behavioural version of this assertion — importing the runtime class and
  // capturing the installed deps — costs 35s of module transform for the whole
  // OrcaRuntime chain (measured), so the wiring itself is pinned by source and the
  // policy's meaning by claude-structured-auth-policy.test.ts.
  it('passes a settings-derived Claude auth policy to the host installer', () => {
    const source = readFileSync(join(__dirname, 'orca-runtime-get-worktree-ps.ts'), 'utf8')

    expect(source).toContain('claudeStructuredAuthPolicyForSettings')
    expect(source).toMatch(
      /resolveClaudeAuthPolicy:\s*\(\)\s*=>\s*\n?\s*claudeStructuredAuthPolicyForSettings\(/
    )
  })

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
