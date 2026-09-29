// A Claude CLI that exits on its own after its start landed, with a message handed to it: the chat
// says Claude stopped, by name. Against the production runtime, adapter, record store and host,
// with only the CLI process scripted.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { waitForStructuredAgentSessionRecovery } from './structured-agent-session-runtime'
import {
  createScriptedClaudeRuntime,
  scriptedClaudeExitError
} from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-exit-mid-response'
const CALLER = { callerKey: 'client-1' }

let claude = createScriptedClaudeRuntime([SESSION])
let operations = 0

afterEach(async () => {
  vi.restoreAllMocks()
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

async function send(host: StructuredAgentSessionHost, text: string): Promise<void> {
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
}

describe('a started Claude CLI that exits while a response is in progress', () => {
  it('says Claude stopped, and that the conversation can continue', async () => {
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    await send(host, 'hello')
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))

    claude.child(SESSION).exit(scriptedClaudeExitError('claude stream-json exited (code 137)'))
    await waitForStructuredAgentSessionRecovery()

    await vi.waitFor(async () =>
      expect(
        (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
          item.body.kind === 'status' && item.body.failure
            ? [{ text: item.body.text, kind: item.body.failure.kind }]
            : []
        )
      ).toEqual([
        {
          text: 'Claude stopped while this response was in progress. You can continue in this conversation.',
          kind: 'providerExited'
        }
      ])
    )
  })

  // The CLI echoed the send and was streaming its reply when it was killed. The adapter ends the
  // running turn itself, at the exit time it stamped; the host must read that turn as one this
  // exit interrupted however late it takes the exit up.
  it('says Claude stopped when the exit lands after the send was accepted and output streamed', async () => {
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    await send(host, 'write a story')
    const child = claude.child(SESSION)
    await vi.waitFor(() => expect(child.sent).toHaveLength(1))
    const providerSession = String(child.launch.options.sessionId)
    child.handlers.onMessage?.({ ...child.sent[0], uuid: 'user-echo' })
    child.handlers.onMessage?.({
      type: 'stream_event',
      session_id: providerSession,
      uuid: 'assistant-partial',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Once upon' } }
    })
    await host.flushStreamedEvents(SESSION)
    await vi.waitFor(async () =>
      expect(
        (await host.journalSnapshot(SESSION)).submissions.map((entry) => entry.dispatchState)
      ).toEqual(['accepted'])
    )

    // As on a loaded machine: the host takes up the exit only after the adapter's own end of the
    // turn has landed in the journal, and on a later millisecond than the one the adapter stamped.
    let clock = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1))
    const handleAdapterEvent = host.handleAdapterEvent
    vi.spyOn(host, 'handleAdapterEvent').mockImplementation(async (event) => {
      await host.flushStreamedEvents(SESSION)
      return handleAdapterEvent(event)
    })
    child.exit(scriptedClaudeExitError('claude stream-json exited (code 137)'))
    await waitForStructuredAgentSessionRecovery()

    await vi.waitFor(async () =>
      expect(
        (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
          item.body.kind === 'status' && item.body.failure ? [item.body.failure.kind] : []
        )
      ).toEqual(['providerExited'])
    )

    // The next send starts a fresh child; settling the dead one again adds no second row.
    vi.mocked(host.handleAdapterEvent).mockRestore()
    await send(host, 'carry on')
    await vi.waitFor(() => expect(claude.children(SESSION)).toHaveLength(2))
    await vi.waitFor(() => expect(claude.child(SESSION).sent).toHaveLength(1))
    await host.flushStreamedEvents(SESSION)
    expect(
      (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
        item.body.kind === 'status' ? [item.body.failure?.kind ?? item.body.text] : []
      )
    ).toEqual(['providerExited'])
  })
})
