// A reopened Claude chat is published as soon as its child spawns, so a CLI that dies before it
// answers initialize fails a session the user is already looking at. That chat must say why, in
// the transcript, exactly as a failed first start does.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { waitForStructuredAgentSessionRecovery } from './structured-agent-session-runtime'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-resumed-start'
const CALLER = { callerKey: 'client-1' }
const DIAGNOSTIC = 'claude stream-json exited (code 1): claude: not signed in'

let claude = createScriptedClaudeRuntime([SESSION])

afterEach(async () => {
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

/** Status rows the open chat was sent, whether in a batch or in the snapshot a fence change sends. */
function statusTexts(events: AgentSessionSubscribeEvent[]): string[] {
  return events.flatMap((event) => {
    const items =
      event.type === 'batch' ? event.batch.items : event.type === 'snapshot' ? event.page.items : []
    return items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
  })
}

describe('a reopened Claude chat whose CLI dies before initialize', () => {
  it('publishes the startup failure, with the diagnostic, to the open chat', async () => {
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    await waitForStructuredAgentSessionRecovery()
    await host.close(SESSION)

    // The user reopens it and sends; this time the CLI never answers, then dies, and its tree is
    // unprovable. Opening starts nothing: the send does.
    claude.behave(SESSION, { initHangs: true, closeUnproven: true })
    const events: AgentSessionSubscribeEvent[] = []
    await host.subscribe({ id: 'sub-1', sessionId: SESSION, emit: (event) => events.push(event) })
    const body = hostTestMessage('hello')
    const fence = host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    const sent = await host.send(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: `${Date.now()}-${'f'.repeat(32)}`,
        expectedRuntimeFence: fence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION,
          fields: { body }
        })
      },
      body
    })
    expect(sent).toMatchObject({ ok: true, value: { submission: { dispatchState: 'pending' } } })
    // Accepted first; the delivery loop starts the second child after.
    await vi.waitFor(() => expect(claude.children(SESSION)).toHaveLength(2))

    claude.child(SESSION).exit(new Error(DIAGNOSTIC))
    await waitForStructuredAgentSessionRecovery()

    await vi.waitFor(() =>
      expect(statusTexts(events)).toContainEqual(
        expect.stringMatching(/stopped before it finished starting: .*not signed in/)
      )
    )
    // Never written, so it did not happen: refused, not left in doubt.
    const submission = (await host.journalSnapshot(SESSION)).submissions.find(
      (entry) => entry.clientMessageId === (sent.ok && sent.value.clientMessageId)
    )
    expect(submission).toMatchObject({ dispatchState: 'rejected' })
  })
})
