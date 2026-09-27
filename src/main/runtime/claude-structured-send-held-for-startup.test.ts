// A Claude chat is published the moment its child spawns, before the CLI has answered initialize.
// A send in that window — into a fresh start, or into the restart a send itself asked for after
// a start that failed — is admitted and held until the child proves its start. When the CLI dies
// first, the held message is rejected with the CLI's own diagnostic, the chat shows the cause
// once, and nothing is left as a delivery nobody can confirm. Against the production runtime,
// adapter, record store and host, with only the CLI process scripted.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { waitForStructuredAgentSessionRecovery } from './structured-agent-session-runtime'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-send-held'
const CALLER = { callerKey: 'client-1' }
const DIAGNOSTIC = 'claude stream-json exited (code 1): claude: not signed in (rig)'

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
  // Admitted and held for the start, never refused: the message shows as sent.
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

function statusRows(host: StructuredAgentSessionHost): string[] {
  return host
    .journalSnapshot(SESSION)
    .items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
}

function submission(host: StructuredAgentSessionHost, clientMessageId: string) {
  return host
    .journalSnapshot(SESSION)
    .submissions.find((entry) => entry.clientMessageId === clientMessageId)
}

/** The CLI keeps dying at startup: the latest child exits with the diagnostic once it exists. */
async function failLatestStart(host: StructuredAgentSessionHost, count: number): Promise<void> {
  await vi.waitFor(() => expect(claude.children(SESSION)).toHaveLength(count))
  claude.child(SESSION).exit(new Error(DIAGNOSTIC))
  await waitForStructuredAgentSessionRecovery()
  await vi.waitFor(() =>
    expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  )
}

describe('a send into a Claude chat whose CLI keeps failing at startup', () => {
  it('restarts once, rejects the held message with the diagnostic when that start dies too, then delivers once the CLI is healthy', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    await failLatestStart(host, 1)
    expect(statusRows(host)).toEqual([expect.stringContaining('not signed in')])
    const releasedFence = fence(host)

    // The send asks for the child back and is held for its start; the CLI dies again first.
    const held = await send(host, 'hello?')
    expect(claude.children(SESSION)).toHaveLength(2)
    expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    await failLatestStart(host, 2)

    // Rejected with the cause, not left in doubt; one row for this attempt names it.
    await vi.waitFor(() =>
      expect(submission(host, held)).toMatchObject({
        dispatchState: 'rejected',
        // Worded for the user: the red line under the composer shows it as it stands.
        reason: `The provider stopped before it finished starting: ${DIAGNOSTIC}.`
      })
    )
    expect(statusRows(host)).toEqual([
      expect.stringContaining('not signed in'),
      expect.stringMatching(/stopped before it finished starting: .*not signed in \(rig\)/)
    ])
    // The restart moved the fence twice: its acquisition, and the exit that released it.
    expect(fence(host)).toBe(releasedFence + 2)
    expect(claude.children(SESSION)).toHaveLength(2)
    expect(claude.child(SESSION).calls).not.toContain('send')

    // The user signs in and retries: one restart, proven, written to the CLI.
    claude.behave(SESSION, {})
    await send(host, 'hello again')
    expect(claude.children(SESSION)).toHaveLength(3)
    expect(fence(host)).toBe(releasedFence + 3)
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    )
    expect(statusRows(host)).toHaveLength(2)
  })
})

describe('a send while the first Claude start is still answering initialize', () => {
  it('is held, and written once the CLI proves its start', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await host.attach(CALLER, claude.attachParams(SESSION, null))

    await send(host, 'hello')
    expect(claude.child(SESSION).calls).not.toContain('send')

    // The CLI answers: startup lands and the held message is written to the proven child.
    claude.child(SESSION).answerInit()

    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
    expect(claude.children(SESSION)).toHaveLength(1)
    expect(statusRows(host)).toEqual([])
  })

  it('is rejected with the diagnostic when the CLI dies first, and restarts nothing', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await host.attach(CALLER, claude.attachParams(SESSION, null))
    const startedFence = fence(host)

    const held = await send(host, 'hello')
    await failLatestStart(host, 1)

    await vi.waitFor(() =>
      expect(submission(host, held)).toMatchObject({
        dispatchState: 'rejected',
        // Worded for the user: the red line under the composer shows it as it stands.
        reason: `The provider stopped before it finished starting: ${DIAGNOSTIC}.`
      })
    )
    expect(statusRows(host)).toEqual([
      expect.stringMatching(/stopped before it finished starting: .*not signed in \(rig\)/)
    ])
    expect(fence(host)).toBe(startedFence + 1)
    expect(claude.children(SESSION)).toHaveLength(1)
    expect(claude.child(SESSION).calls).not.toContain('send')
  })
})
