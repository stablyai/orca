// Reopened chats publish before initialize; later startup failure must reach the visible transcript.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { waitForStructuredAgentSessionRecovery } from './structured-agent-session-runtime'
import {
  createScriptedClaudeRuntime,
  scriptedClaudeExitError
} from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-resumed-start'
const CALLER = { callerKey: 'client-1' }
const DIAGNOSTIC = 'claude stream-json exited (code 1): claude: not signed in'
const STARTUP_TEXT = 'Claude stopped before it finished starting. Send your message to try again.'

let claude = createScriptedClaudeRuntime([SESSION])

afterEach(async () => {
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

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
    await host.close(SESSION, 'evict')

    // Opening starts nothing; the send retries children whose root exits are observed,
    // even when descendant cleanup cannot be confirmed.
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
    await vi.waitFor(() => expect(claude.children(SESSION)).toHaveLength(2))

    for (let count = 2; count <= 6; count++) {
      await vi.waitFor(() => expect(claude.children(SESSION)).toHaveLength(count), {
        timeout: 10_000
      })
      await vi.waitFor(() => expect(claude.child(SESSION).initializing).toBe(true))
      expect(statusTexts(events)).not.toContain(STARTUP_TEXT)
      claude.child(SESSION).exit(scriptedClaudeExitError(DIAGNOSTIC))
      await waitForStructuredAgentSessionRecovery()
      await vi.waitFor(() =>
        expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
      )
    }

    await vi.waitFor(() => expect(statusTexts(events)).toContainEqual(STARTUP_TEXT))
    const submission = (await host.journalSnapshot(SESSION)).submissions.find(
      (entry) => entry.clientMessageId === (sent.ok && sent.value.clientMessageId)
    )
    // Keep stderr in log details, outside the user-facing sentence.
    expect(submission).toMatchObject({
      dispatchState: 'rejected',
      reason: STARTUP_TEXT,
      rejection: { kind: 'providerStartFailed', detail: { text: DIAGNOSTIC, audience: 'log' } }
    })
  })
})
