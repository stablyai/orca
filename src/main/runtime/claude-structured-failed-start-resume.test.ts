// Unproven first starts have no transcript: retry the same provider id fresh until a start proves its root.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeSessionIdForOrcaSession } from '../claude/claude-structured-launch-resolution'
import { waitForStructuredAgentSessionRecovery } from './structured-agent-session-runtime'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-failed-start'
const CALLER = { callerKey: 'client-1' }

let claude = createScriptedClaudeRuntime([SESSION])

afterEach(async () => {
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

describe('a Claude chat whose first start died before initialize', () => {
  it('resumes on reopen, launching its id fresh and continuing the same chain', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    await vi.waitFor(() => expect(claude.child(SESSION).initializing).toBe(true))
    claude.child(SESSION).exit(new Error('claude stream-json exited (code 1): not signed in'))
    await waitForStructuredAgentSessionRecovery()
    const failed = host.deps.store.getRecord(SESSION)
    expect(failed?.lease.claimStatus).toBe('released')

    claude.behave(SESSION, {})
    const reopened = await host.attach(
      CALLER,
      claude.attachParams(SESSION, failed?.lease.runtimeFence ?? null)
    )

    expect(reopened, JSON.stringify(reopened)).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
    )
    const providerSessionId = claudeSessionIdForOrcaSession(SESSION)
    // No transcript exists to resume.
    expect(claude.child(SESSION).launch.options).toMatchObject({ sessionId: providerSessionId })
    expect(claude.child(SESSION).launch.options.resume).toBeUndefined()
    expect(
      host.deps.store.getRecord(SESSION)?.providerHandleChain.map((link) => link.origin)
    ).toEqual(['created'])
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    )
  })
})

describe('a Claude chat whose CLI exits the moment it is spawned', () => {
  // Exit may race spawn or start-time read; both must preserve the CLI verdict.
  it.each(['spawn', 'start-time-read'] as const)(
    "refuses the create in a sentence, not the CLI's diagnostic, when it exits at %s",
    async (at) => {
      const diagnostic = 'claude stream-json exited (code 1): claude: not signed in'
      claude.behave(SESSION, { exitsDuringSpawn: { diagnostic, at } })
      const host = await claude.install()

      const created = await host.attach(CALLER, claude.attachParams(SESSION, null))

      expect(created).toMatchObject({
        ok: false,
        refusal: {
          message: 'Claude stopped before it finished starting. Send your message to try again.',
          ownerVerdict: 'exited'
        }
      })
    }
  )
})
