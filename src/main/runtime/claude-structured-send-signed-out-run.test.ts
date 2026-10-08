// A Claude CLI that is not signed in fails every start the same way. The chat's own start leaves one
// row; each message sent after it makes its own start, is rejected with the same typed failure, and
// adds no row: nothing was delivered between them. Against the production runtime, adapter, record
// store and host, with only the CLI process scripted.

import { afterEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { waitForStructuredAgentSessionRecovery } from './structured-agent-session-runtime'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-signed-out-run'
const CALLER = { callerKey: 'client-1' }
const SIGNED_OUT =
  'Claude is not signed in for the selected account. Sign in, then send your message again.'

let claude = createScriptedClaudeRuntime([SESSION])
let operations = 0

afterEach(async () => {
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

async function send(host: StructuredAgentSessionHost, text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`,
      expectedRuntimeFence: host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
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

async function statusRows(host: StructuredAgentSessionHost): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' ? [item.body.text] : []
  )
}

async function submission(host: StructuredAgentSessionHost, clientMessageId: string) {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

it('keeps one row for a chat whose every start fails not signed in, however often it is sent to', async () => {
  claude.behave(SESSION, { signedOut: true })
  const host = await claude.install()
  await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
    ok: true
  })
  await waitForStructuredAgentSessionRecovery()
  await vi.waitFor(async () => expect(await statusRows(host)).toEqual([SIGNED_OUT]))

  for (const [index, text] of ['first', 'second', 'third'].entries()) {
    const id = await send(host, text)
    await vi.waitFor(async () =>
      expect(await submission(host, id)).toMatchObject({ dispatchState: 'rejected' })
    )
    // The typed failure carries no provider words, so each attempt states the same one.
    expect((await submission(host, id))?.rejection).toEqual({ kind: 'notSignedIn' })
    expect(claude.children(SESSION)).toHaveLength(index + 2)
  }
  await waitForStructuredAgentSessionRecovery()

  expect(await statusRows(host)).toEqual([SIGNED_OUT])
})
