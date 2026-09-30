// A Claude send whose write ended in doubt is recorded `unknown`, and a live `unknown` reads as
// work still owed. The CLI reports `session_state_changed idle` only once its queue has drained,
// so that report retires the doubt; a send whose dispatch is still `pending` is left alone.
// Against the production runtime, adapter, record store and host, with only the CLI scripted.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { claudeSessionIdForOrcaSession } from '../claude/claude-structured-launch-resolution'
import { DISPATCH_DOUBT_WRITE_OUTCOME_UNKNOWN } from '../native-chat/agent-session-journal/journal-dispatch-doubt-reasons'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-idle-release'
const PROVIDER_SESSION = claudeSessionIdForOrcaSession(SESSION)
const CALLER = { callerKey: 'client-1' }

let claude = createScriptedClaudeRuntime([SESSION])
let operations = 0

afterEach(async () => {
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

function fence(host: StructuredAgentSessionHost): number {
  return host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
}

async function send(host: StructuredAgentSessionHost, text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`,
      expectedRuntimeFence: fence(host),
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true })
  return sent.ok ? sent.value.clientMessageId : ''
}

async function submission(host: StructuredAgentSessionHost, clientMessageId: string) {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

function sessionState(state: 'running' | 'idle'): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'session_state_changed',
    state,
    uuid: `state-${state}`,
    session_id: PROVIDER_SESSION
  }
}

describe('a live Claude chat whose CLI reports idle', () => {
  it('releases a send whose write ended in doubt, and leaves a pending one alone', async () => {
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    const child = claude.child(SESSION)
    // Handed to the SDK, then the write's outcome was lost.
    child.connection.send = async (_message, beforeDispatch) => {
      await beforeDispatch?.()
      throw new Error('stdin write stalled')
    }
    const doubted = await send(host, 'first')
    await vi.waitFor(async () =>
      expect(await submission(host, doubted)).toMatchObject({ dispatchState: 'unknown' })
    )
    // Written, never echoed: its dispatch has returned, but nothing has settled it.
    child.connection.send = async (_message, beforeDispatch) => {
      await beforeDispatch?.()
    }
    const pending = await send(host, 'second')
    await vi.waitFor(async () =>
      expect(await submission(host, pending)).toMatchObject({ dispatchState: 'pending' })
    )

    child.handlers.onMessage?.(sessionState('running'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    // POSITIVE CONTROL: only idle releases it.
    expect((await submission(host, doubted))?.recovered).toBeUndefined()

    child.handlers.onMessage?.(sessionState('idle'))

    await vi.waitFor(async () =>
      expect(await submission(host, doubted)).toMatchObject({
        dispatchState: 'unknown',
        recovered: true,
        // The write's own doubt is the sharper fact, so it survives the release.
        reason: `${DISPATCH_DOUBT_WRITE_OUTCOME_UNKNOWN}: stdin write stalled`
      })
    )
    expect(await submission(host, pending)).toMatchObject({ dispatchState: 'pending' })
    expect((await submission(host, pending))?.recovered).toBeUndefined()
  })
})
