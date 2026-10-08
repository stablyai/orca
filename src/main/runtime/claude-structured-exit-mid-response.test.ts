// A Claude CLI that exits on its own after its start landed, with a message handed to it: the chat
// says Claude stopped, by name. Against the production runtime, adapter, record store and host,
// with only the CLI process scripted.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { withNativeChatCutTurnNotices } from '../../shared/native-chat-cut-turn-notice'
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
    // The agent really died on its own, so the reader shows this one row, in its error tone, and
    // derives no interrupted notice beside it.
    const { items } = await host.journalSnapshot(SESSION)
    expect(
      withNativeChatCutTurnNotices(items).flatMap((item) =>
        item.body.kind === 'status' ? [{ text: item.body.text, tone: item.body.tone }] : []
      )
    ).toEqual([
      {
        text: 'Claude stopped while this response was in progress. You can continue in this conversation.',
        tone: 'error'
      }
    ])
  })
})
