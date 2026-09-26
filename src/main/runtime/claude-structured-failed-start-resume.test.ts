// A Claude chat whose first start died before initialize (not signed in, a crash) wrote no
// transcript, so its next start launches that same provider id fresh. It is still the same
// conversation: the new child continues the record's chain rather than creating a second root.

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
    claude.child(SESSION).exit(new Error('claude stream-json exited (code 1): not signed in'))
    await waitForStructuredAgentSessionRecovery()
    const failed = host.deps.store.getRecord(SESSION)
    expect(failed?.lease.claimStatus).toBe('released')

    // The user signs in and reopens the chat.
    claude.behave(SESSION, {})
    const reopened = await host.attach(
      CALLER,
      claude.attachParams(SESSION, failed?.lease.runtimeFence ?? null)
    )

    expect(reopened, JSON.stringify(reopened)).toMatchObject({ ok: true })
    const providerSessionId = claudeSessionIdForOrcaSession(SESSION)
    // No transcript exists to `--resume`, so the id is started fresh...
    expect(claude.child(SESSION).launch.options).toMatchObject({ sessionId: providerSessionId })
    expect(claude.child(SESSION).launch.options.resume).toBeUndefined()
    // ...and the record still holds one conversation under one root.
    expect(
      host.deps.store.getRecord(SESSION)?.providerHandleChain.map((link) => link.origin)
    ).toEqual(['created', 'resumed'])
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    )
  })
})

describe('a Claude chat whose CLI exits the moment it is spawned', () => {
  // Before the spawn returns, the start time of a dead pid is unreadable; during that read, the
  // child is found closed afterwards. Both must answer with what the CLI said.
  it.each(['spawn', 'start-time-read'] as const)(
    "refuses the create with the CLI's own diagnostic when it exits at %s",
    async (at) => {
      const diagnostic = 'claude stream-json exited (code 1): claude: not signed in'
      claude.behave(SESSION, { exitsDuringSpawn: { diagnostic, at } })
      const host = await claude.install()

      const created = await host.attach(CALLER, claude.attachParams(SESSION, null))

      expect(created).toMatchObject({
        ok: false,
        refusal: { message: expect.stringContaining('not signed in'), ownerVerdict: 'exited' }
      })
    }
  )
})
