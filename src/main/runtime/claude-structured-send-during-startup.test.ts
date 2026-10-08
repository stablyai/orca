// A Claude chat is published the moment its child spawns, before the CLI has answered initialize,
// and launched with the chat's saved options. A send in that window — into a fresh start, or into
// the restart the delivery loop makes for a send after a start that failed — is written to the CLI
// at once, which takes it behind its own start. When the CLI dies before answering, the message is
// rejected with the CLI's own diagnostic, the chat shows the cause once, and nothing is left as a
// delivery nobody can confirm. Against the production runtime, adapter, record store and host, with
// only the CLI process scripted.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { waitForStructuredAgentSessionRecovery } from './structured-agent-session-runtime'
import {
  createScriptedClaudeRuntime,
  scriptedClaudeExitError
} from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-send-held'
const CALLER = { callerKey: 'client-1' }
const DIAGNOSTIC = 'claude stream-json exited (code 1): claude: not signed in (rig)'
const STARTUP_TEXT = 'Claude stopped before it finished starting. Send your message to try again.'

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
      expectedRuntimeFence: fence(host),
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  // Accepted, never refused: the message shows as sent.
  expect(sent, JSON.stringify(sent)).toMatchObject({
    ok: true,
    replayed: false,
    value: { submission: { dispatchState: 'pending' } }
  })
  return sent.ok ? sent.value.clientMessageId : ''
}

function fence(host: StructuredAgentSessionHost): number {
  return host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
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

/** The CLI keeps dying at startup: the latest child exits with the diagnostic once it exists. */
async function failLatestStart(host: StructuredAgentSessionHost, count: number): Promise<void> {
  await vi.waitFor(() => expect(claude.children(SESSION)).toHaveLength(count))
  claude.child(SESSION).exit(scriptedClaudeExitError(DIAGNOSTIC))
  await waitForStructuredAgentSessionRecovery()
  await vi.waitFor(() =>
    expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  )
}

describe('a send into a Claude chat whose CLI keeps failing at startup', () => {
  it('restarts once, rejects the message it wrote with the diagnostic when that start dies too, then delivers once the CLI is healthy', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    await failLatestStart(host, 1)
    expect(await statusRows(host)).toEqual([STARTUP_TEXT])
    const releasedFence = fence(host)

    // The delivery loop asks for the child back and writes the message to it at once; the CLI
    // dies again before it answers initialize.
    const held = await send(host, 'hello?')
    await vi.waitFor(() => expect(claude.children(SESSION)).toHaveLength(2))
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    )
    await failLatestStart(host, 2)

    // Rejected with the cause, not left in doubt; the open's row already names it, so no second.
    await vi.waitFor(async () =>
      expect(await submission(host, held)).toMatchObject({
        dispatchState: 'rejected',
        // Worded for the user: the red line under the composer shows it as it stands.
        reason: STARTUP_TEXT,
        rejection: { kind: 'providerStartFailed' }
      })
    )
    expect(await statusRows(host)).toEqual([STARTUP_TEXT])
    // The restart moved the fence twice: its acquisition, and the exit that released it.
    expect(fence(host)).toBe(releasedFence + 2)
    expect(claude.children(SESSION)).toHaveLength(2)

    // The user signs in and retries: one restart, proven, written to the CLI.
    claude.behave(SESSION, {})
    await send(host, 'hello again')
    await vi.waitFor(() => expect(claude.children(SESSION)).toHaveLength(3))
    await vi.waitFor(() => expect(fence(host)).toBe(releasedFence + 3))
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    )
    expect(await statusRows(host)).toHaveLength(1)
  })
})

describe('a send while the first Claude start is still answering initialize', () => {
  it('is written to the CLI at once, before it answers', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await host.attach(CALLER, claude.attachParams(SESSION, null))

    const sent = await send(host, 'hello')
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
    expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')

    // The CLI answers: the start lands under the message already written, and nothing fails.
    claude.child(SESSION).answerInit()

    await vi.waitFor(() =>
      expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
    )
    expect(claude.child(SESSION).calls.filter((call) => call === 'send')).toHaveLength(1)
    expect((await submission(host, sent))?.dispatchState).not.toBe('rejected')
    expect(claude.children(SESSION)).toHaveLength(1)
    expect(await statusRows(host)).toEqual([])
  })

  // Only a SessionStart hook makes the CLI name its session before the first turn, and that hook
  // comes from status hooks a user can turn off; the initialize answer alone starts the chat.
  it('is written at once, and the start lands, with no start frame before the first turn', async () => {
    claude.behave(SESSION, { initHangs: true, sendsNoStartFrame: true })
    const host = await claude.install()
    await host.attach(CALLER, claude.attachParams(SESSION, null))

    await send(host, 'hello')
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
    claude.child(SESSION).answerInit()

    await vi.waitFor(() =>
      expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
    )
    expect(claude.children(SESSION)).toHaveLength(1)
    expect(await statusRows(host)).toEqual([])
  })

  it('is rejected with the diagnostic when the CLI dies before answering, and restarts nothing', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await host.attach(CALLER, claude.attachParams(SESSION, null))
    const startedFence = fence(host)

    const held = await send(host, 'hello')
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
    await failLatestStart(host, 1)

    await vi.waitFor(async () =>
      expect(await submission(host, held)).toMatchObject({
        dispatchState: 'rejected',
        // Worded for the user: the red line under the composer shows it as it stands.
        reason: STARTUP_TEXT,
        rejection: { kind: 'providerStartFailed' }
      })
    )
    expect(await statusRows(host)).toEqual([STARTUP_TEXT])
    expect(fence(host)).toBe(startedFence + 1)
    expect(claude.children(SESSION)).toHaveLength(1)
  })
})
