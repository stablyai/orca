// Accept sends during startup, then dispatch once initialize proves the start; reject never-written sends on failure.

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

async function written(host: StructuredAgentSessionHost): Promise<boolean> {
  await vi.waitFor(() =>
    expect(host.collaboratorsForTests().conversationDelivery.loop.isRunning(SESSION)).toBe(true)
  )
  return claude.child(SESSION).calls.includes('send')
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

async function failLatestStart(host: StructuredAgentSessionHost, count: number): Promise<void> {
  await vi.waitFor(() => expect(claude.children(SESSION)).toHaveLength(count))
  claude.child(SESSION).exit(scriptedClaudeExitError(DIAGNOSTIC))
  await waitForStructuredAgentSessionRecovery()
  await vi.waitFor(() =>
    expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  )
}

describe('a send into a Claude chat whose CLI keeps failing at startup', () => {
  it('restarts once, rejects the message held for it with the diagnostic when that start dies too, then delivers once the CLI is healthy', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })
    await failLatestStart(host, 1)
    expect(await statusRows(host)).toEqual([STARTUP_TEXT])
    const releasedFence = fence(host)

    const held = await send(host, 'hello?')
    await vi.waitFor(() => expect(claude.children(SESSION)).toHaveLength(2))
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    )
    expect(await written(host)).toBe(false)
    await failLatestStart(host, 2)

    await vi.waitFor(async () =>
      expect(await submission(host, held)).toMatchObject({
        dispatchState: 'rejected',
        reason: STARTUP_TEXT,
        rejection: { kind: 'providerStartFailed' }
      })
    )
    expect(await statusRows(host)).toEqual([STARTUP_TEXT, STARTUP_TEXT])
    // Restart acquisition and exit release each advance the fence.
    expect(fence(host)).toBe(releasedFence + 2)
    expect(claude.children(SESSION)).toHaveLength(2)

    claude.behave(SESSION, {})
    await send(host, 'hello again')
    await vi.waitFor(() => expect(claude.children(SESSION)).toHaveLength(3))
    await vi.waitFor(() => expect(fence(host)).toBe(releasedFence + 3))
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    )
    expect(await statusRows(host)).toHaveLength(2)
  })
})

describe('a send while the first Claude start is still answering initialize', () => {
  it('is held from the CLI until it answers, then written once', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await host.attach(CALLER, claude.attachParams(SESSION, null))

    const sent = await send(host, 'hello')
    expect(await written(host)).toBe(false)
    expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')

    claude.child(SESSION).answerInit()

    await vi.waitFor(() =>
      expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
    )
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
    expect(claude.child(SESSION).calls.filter((call) => call === 'send')).toHaveLength(1)
    expect((await submission(host, sent))?.dispatchState).not.toBe('rejected')
    expect(claude.children(SESSION)).toHaveLength(1)
    expect(await statusRows(host)).toEqual([])
  })

  // SessionStart depends on optional status hooks; initialize alone must establish startup.
  it('lands its start and is written, with no start frame before the first turn', async () => {
    claude.behave(SESSION, { initHangs: true, sendsNoStartFrame: true })
    const host = await claude.install()
    await host.attach(CALLER, claude.attachParams(SESSION, null))

    await send(host, 'hello')
    expect(await written(host)).toBe(false)
    claude.child(SESSION).answerInit()

    await vi.waitFor(() =>
      expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
    )
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
    expect(claude.children(SESSION)).toHaveLength(1)
    expect(await statusRows(host)).toEqual([])
  })

  it('is rejected with the diagnostic when the CLI dies before answering, and restarts nothing', async () => {
    claude.behave(SESSION, { initHangs: true })
    const host = await claude.install()
    await host.attach(CALLER, claude.attachParams(SESSION, null))
    const startedFence = fence(host)

    const held = await send(host, 'hello')
    expect(await written(host)).toBe(false)
    await failLatestStart(host, 1)

    await vi.waitFor(async () =>
      expect(await submission(host, held)).toMatchObject({
        dispatchState: 'rejected',
        reason: STARTUP_TEXT,
        rejection: { kind: 'providerStartFailed' }
      })
    )
    expect(await statusRows(host)).toEqual([STARTUP_TEXT])
    expect(fence(host)).toBe(startedFence + 1)
    expect(claude.children(SESSION)).toHaveLength(1)
  })
})
