// A Claude start can fail on Orca's side while the CLI is still running: a saved option it can't
// restore, or an init frame naming another session. Orca ends that child itself, so the message the
// start was for must not say Claude stopped on its own; only an exit Orca saw says that. Against the production
// runtime, adapter, record store and host, with only the CLI process scripted.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { waitForStructuredAgentSessionRecovery } from './structured-agent-session-runtime'
import {
  createScriptedClaudeRuntime,
  scriptedClaudeExitError
} from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-startup-fault'
const CALLER = { callerKey: 'client-1' }
const DIAGNOSTIC = 'claude stream-json exited (code 1): claude: not signed in (rig)'
const STOPPED_TEXT = 'Claude stopped before it finished starting. Send your message to try again.'

let claude = createScriptedClaudeRuntime([SESSION])
let operations = 0

afterEach(async () => {
  vi.restoreAllMocks()
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
  expect(sent, JSON.stringify(sent)).toMatchObject({
    ok: true,
    value: { submission: { dispatchState: 'pending' } }
  })
  return sent.ok ? sent.value.clientMessageId : ''
}

async function failureRows(host: StructuredAgentSessionHost) {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' && item.body.failure
      ? [{ text: item.body.text, kind: item.body.failure.kind }]
      : []
  )
}

async function submission(host: StructuredAgentSessionHost, clientMessageId: string) {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

async function released(host: StructuredAgentSessionHost): Promise<void> {
  await waitForStructuredAgentSessionRecovery()
  await vi.waitFor(() =>
    expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  )
}

describe('a Claude start that Orca fails while the CLI is still running', () => {
  it('ends the start quietly when a saved option cannot be restored and no message waited on it', async () => {
    claude.behave(SESSION, { optionWritesFail: true })
    const host = await claude.install()
    await expect(
      host.attach(
        CALLER,
        claude.attachParams(SESSION, null, { options: { permissionMode: 'plan' } })
      )
    ).resolves.toMatchObject({ ok: true })
    await released(host)

    expect(claude.child(SESSION).calls).toContain('set_permission_mode')
    // Nothing waited on the open's start: the first message says why, when there is one.
    expect(await failureRows(host)).toEqual([])
  })

  it('records on a held message a start that could not happen when init names another session', async () => {
    claude.behave(SESSION, { initHangs: true, initNamesForeignSession: true })
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    const held = await send(host, 'hello')

    claude.child(SESSION).answerInit()
    await released(host)

    await vi.waitFor(async () =>
      expect(await submission(host, held)).toMatchObject({
        dispatchState: 'rejected',
        reason: expect.stringMatching(/^Claude couldn't start\./),
        rejection: { kind: 'startFailed' }
      })
    )
    expect(await submission(host, held)).not.toHaveProperty('startRetry')
    expect(await failureRows(host)).toEqual([])
    expect(claude.child(SESSION).calls).not.toContain('send')
  })

  it('still says Claude stopped when the CLI exits on its own before its start lands', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    const held = await send(host, 'hello')

    claude.child(SESSION).exit(scriptedClaudeExitError(DIAGNOSTIC))
    await released(host)

    await vi.waitFor(async () =>
      expect(await submission(host, held)).toMatchObject({
        dispatchState: 'rejected',
        reason: STOPPED_TEXT,
        rejection: { kind: 'providerStartFailed' }
      })
    )
    expect(await submission(host, held)).not.toHaveProperty('startRetry')
    expect(await failureRows(host)).toEqual([])
  })
})
