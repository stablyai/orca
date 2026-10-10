// A Claude start asks the CLI one control request after initialize, its settings read, under the
// ordinary request deadline; the chat's saved options ride the launch, so no option write runs at
// startup. A CLI that answers initialize and then answers no control request still starts, on its
// launch options, and the saved choices stay saved. Against the production runtime, adapter, record
// store and host, with only the CLI process scripted.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { claudeSessionIdForOrcaSession } from '../claude/claude-structured-launch-resolution'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-startup-unanswered-control'
const CALLER = { callerKey: 'client-1' }
const DEADLINE_MS = 50
/** As live: no frame before the first turn names a model, so only a turn reports one. */
const LIVE_START = { sendsNoStartFrame: true }

let claude = createScriptedClaudeRuntime([SESSION])
let operations = 0

afterEach(async () => {
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

function record(host: StructuredAgentSessionHost) {
  return host.deps.store.getRecord(SESSION)
}

function operationId(): string {
  return `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`
}

async function setOption(
  host: StructuredAgentSessionHost,
  key: string,
  value: string
): Promise<void> {
  const changed = await host.setOption(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: operationId(),
      expectedRuntimeFence: record(host)?.lease.runtimeFence ?? 0,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.setOption',
        sessionId: SESSION,
        fields: { key, value }
      })
    },
    key,
    value
  })
  expect(changed, JSON.stringify(changed)).toMatchObject({ ok: true })
}

/** What the picker is handed: the value it shows, and which ones the CLI vouched for. */
async function picker(host: StructuredAgentSessionHost) {
  const { model, effort, confirmed } = (await host.readOptions(SESSION)).current
  return { model, effort, confirmed }
}

/** The CLI opens a turn by naming the model it is actually running. */
function turnReportsModel(model: string): void {
  claude.child(SESSION).handlers.onMessage?.({
    type: 'system',
    subtype: 'init',
    session_id: claudeSessionIdForOrcaSession(SESSION),
    model
  })
}

async function statusRows(host: StructuredAgentSessionHost): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' ? [item.body.text] : []
  )
}

async function send(host: StructuredAgentSessionHost, text: string): Promise<void> {
  await sendTo(host, SESSION, text)
}

async function sendTo(
  host: StructuredAgentSessionHost,
  sessionId: string,
  text: string
): Promise<void> {
  const body = hostTestMessage(text)
  await expect(
    host.send(CALLER, {
      envelope: {
        sessionId,
        clientOperationId: operationId(),
        expectedRuntimeFence: host.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId,
          fields: { body }
        })
      },
      body
    })
  ).resolves.toMatchObject({ ok: true })
}

describe('a Claude start whose CLI answers initialize but not a control request', () => {
  it('launches with the saved choices, writes none of them, and keeps them saved', async () => {
    claude.behave(SESSION, { ...LIVE_START, optionWritesHang: true, controlTimeoutMs: DEADLINE_MS })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = await claude.install()
    const saved = { model: 'sonnet', permissionMode: 'plan' }
    await expect(
      host.attach(CALLER, claude.attachParams(SESSION, null, { options: saved }))
    ).resolves.toMatchObject({ ok: true })

    await vi.waitFor(() => expect(record(host)?.lease.claimStatus).toBe('live'), {
      timeout: DEADLINE_MS * 40
    })
    expect(claude.child(SESSION).launch.options).toMatchObject({
      model: 'sonnet',
      permissionMode: 'plan'
    })
    // The record keeps the saved choices through the start.
    await vi.waitFor(() => expect(record(host)?.options).toEqual({ ...saved, effort: 'high' }), {
      timeout: DEADLINE_MS * 40
    })
    expect(host.deps.adapter.readOptionRestoreFailures?.(SESSION)).toEqual([])
    expect(await statusRows(host)).toEqual([])
    expect(claude.children(SESSION)).toHaveLength(1)
    expect(claude.child(SESSION).calls).not.toContain('set_model')
    expect(claude.child(SESSION).calls).not.toContain('set_permission_mode')

    await send(host, 'hello')
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
  })

  it('keeps the launched saved choice when the user later changes a different option', async () => {
    const behavior = { ...LIVE_START, optionWritesHang: true, controlTimeoutMs: DEADLINE_MS }
    claude.behave(SESSION, behavior)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = await claude.install()
    await expect(
      host.attach(CALLER, claude.attachParams(SESSION, null, { options: { model: 'sonnet' } }))
    ).resolves.toMatchObject({ ok: true })
    await vi.waitFor(
      () => expect(record(host)?.options).toEqual({ model: 'sonnet', effort: 'high' }),
      {
        timeout: DEADLINE_MS * 40
      }
    )

    // The CLI answers again; the user sets another option on the running child.
    behavior.optionWritesHang = false
    await setOption(host, 'permissionMode', 'plan')
    expect(record(host)?.options).toMatchObject({ model: 'sonnet', permissionMode: 'plan' })
  })

  it('launches the saved model again after a turn reports another model, another option changes, and the chat is cleared', async () => {
    claude = createScriptedClaudeRuntime([SESSION])
    const behavior = { ...LIVE_START, optionWritesHang: true, controlTimeoutMs: DEADLINE_MS }
    claude.behave(SESSION, behavior)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = await claude.install()
    await expect(
      host.attach(CALLER, claude.attachParams(SESSION, null, { options: { model: 'sonnet' } }))
    ).resolves.toMatchObject({ ok: true })
    await vi.waitFor(
      () => expect(record(host)?.options).toEqual({ model: 'sonnet', effort: 'high' }),
      { timeout: DEADLINE_MS * 40 }
    )
    // The picker offers the saved model, which nothing has vouched for yet.
    expect(await picker(host)).toEqual({ model: 'sonnet', effort: 'high', confirmed: ['effort'] })

    // A turn shows the child running the CLI's own model: the picker follows it, the record
    // keeps what the user chose.
    turnReportsModel('claude-sonnet-5')
    expect(await picker(host)).toEqual({
      model: 'claude-sonnet-5',
      effort: 'high',
      confirmed: ['model', 'effort']
    })
    expect(record(host)?.options).toEqual({ model: 'sonnet', effort: 'high' })

    behavior.optionWritesHang = false
    await setOption(host, 'permissionMode', 'plan')
    expect(record(host)?.options).toEqual({ model: 'sonnet', permissionMode: 'plan' })

    const cleared = await host.conversationCommand(CALLER, {
      command: 'clear',
      envelope: {
        sessionId: SESSION,
        clientOperationId: operationId(),
        expectedRuntimeFence: record(host)?.lease.runtimeFence ?? 0,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.conversationCommand',
          sessionId: SESSION,
          fields: { command: 'clear' }
        })
      }
    })
    expect(cleared, JSON.stringify(cleared)).toMatchObject({
      ok: true,
      value: { command: 'clear', state: 'completed' }
    })
    expect(cleared.ok && cleared.value.replacementSessionId).toBeUndefined()
    const boundary = record(host)?.providerContextBoundary
    expect(boundary).toBeDefined()
    const freshProviderSessionId = claudeSessionIdForOrcaSession(SESSION, boundary?.operationId)
    expect(freshProviderSessionId).not.toBe(claudeSessionIdForOrcaSession(SESSION))
    claude.behave(SESSION, LIVE_START)
    // The cleared chat starts nothing until its first message.
    expect(claude.children(SESSION)).toHaveLength(1)
    expect(claude.child(SESSION).connection.closed).toBe(true)
    await send(host, 'first message')
    await vi.waitFor(() => expect(claude.children(SESSION)).toHaveLength(2))
    expect(claude.child(SESSION).launch.options).toMatchObject({
      sessionId: freshProviderSessionId,
      model: 'sonnet',
      permissionMode: 'plan'
    })
    expect(claude.child(SESSION).launch.options.resume).toBeUndefined()
    await vi.waitFor(() =>
      expect(record(host)?.options).toEqual({
        model: 'sonnet',
        effort: 'high',
        permissionMode: 'plan'
      })
    )
  })

  it('replaces the launched saved model with the one the user then sets', async () => {
    const behavior = { ...LIVE_START, optionWritesHang: true, controlTimeoutMs: DEADLINE_MS }
    claude.behave(SESSION, behavior)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = await claude.install()
    await expect(
      host.attach(CALLER, claude.attachParams(SESSION, null, { options: { model: 'sonnet' } }))
    ).resolves.toMatchObject({ ok: true })
    // The record holds the saved model from creation; only the start's own report (effort) says
    // startup finished, and an option write before then waits for it.
    await vi.waitFor(
      () => expect(record(host)?.options).toEqual({ model: 'sonnet', effort: 'high' }),
      { timeout: DEADLINE_MS * 40 }
    )
    turnReportsModel('claude-sonnet-5')

    behavior.optionWritesHang = false
    await setOption(host, 'model', 'opus')
    expect(record(host)?.options).toEqual({ model: 'opus' })
    expect((await picker(host)).model).toBe('opus')
  })

  it("lands with effort unknown when startup's own settings read goes unanswered", async () => {
    claude.behave(SESSION, { startupSettingsReadHangs: true, controlTimeoutMs: DEADLINE_MS })
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })

    await vi.waitFor(() => expect(record(host)?.options).toEqual({ model: 'claude-sonnet-5' }), {
      timeout: DEADLINE_MS * 40
    })
    expect(record(host)?.lease.claimStatus).toBe('live')
    expect(await statusRows(host)).toEqual([])
    expect(claude.children(SESSION)).toHaveLength(1)
  })
})
