// Settings-read timeouts must not block initialized startup or overwrite saved launch options.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { claudeSessionIdForOrcaSession } from '../claude/structured/claude-structured-session-id'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-startup-unanswered-control'
const CALLER = { callerKey: 'client-1' }
const DEADLINE_MS = 50
/** Live startup names no model until the first turn. */
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

async function ready(host: StructuredAgentSessionHost): Promise<void> {
  await vi.waitFor(
    () => expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready'),
    {
      timeout: DEADLINE_MS * 40
    }
  )
}

async function picker(host: StructuredAgentSessionHost) {
  const { model, effort, confirmed } = (await host.readOptions(SESSION)).current
  return { model, effort, confirmed }
}

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
    const saved = { model: 'sonnet', effort: 'high', permissionMode: 'accept-edits' }
    await expect(
      host.attach(CALLER, claude.attachParams(SESSION, null, { options: saved }))
    ).resolves.toMatchObject({ ok: true })

    await vi.waitFor(() => expect(record(host)?.lease.claimStatus).toBe('live'), {
      timeout: DEADLINE_MS * 40
    })
    expect(claude.child(SESSION).launch.options).toMatchObject({
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'acceptEdits'
    })
    await ready(host)
    expect(record(host)?.options).toEqual({ model: 'sonnet', effort: 'high' })
    expect(record(host)?.permissionMode).toBe('accept-edits')
    expect(await statusRows(host)).toEqual([])
    expect(claude.children(SESSION)).toHaveLength(1)
    expect(claude.child(SESSION).calls).not.toContain('set_model')
    expect(claude.child(SESSION).calls).not.toContain('set_permission_mode')

    claude.child(SESSION).connection.getSettings = async () => ({
      applied: { effort: 'high' },
      effective: { effortLevel: 'low' }
    })
    await host.readOptions(SESSION)
    await send(host, 'hello')
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
    expect(claude.child(SESSION).calls).not.toContain('set_model')
    expect(claude.child(SESSION).calls).not.toContain('apply_flag_settings')
  })

  it('keeps the launched saved choice when the user later changes a different option', async () => {
    const behavior = { ...LIVE_START, optionWritesHang: true, controlTimeoutMs: DEADLINE_MS }
    claude.behave(SESSION, behavior)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = await claude.install()
    await expect(
      host.attach(CALLER, claude.attachParams(SESSION, null, { options: { model: 'sonnet' } }))
    ).resolves.toMatchObject({ ok: true })
    await ready(host)
    expect(record(host)?.options).toEqual({ model: 'sonnet' })

    behavior.optionWritesHang = false
    await setOption(host, 'permissionMode', 'accept-edits')
    expect(record(host)).toMatchObject({
      options: { model: 'sonnet' },
      permissionMode: 'accept-edits'
    })
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
    await ready(host)
    expect(record(host)?.options).toEqual({ model: 'sonnet' })
    // Saved model is offered before provider confirmation.
    expect(await picker(host)).toEqual({ model: 'sonnet', effort: 'high', confirmed: ['effort'] })

    // Turn reports must not replace the next send's saved choice.
    turnReportsModel('claude-sonnet-5')
    expect(await picker(host)).toEqual({
      model: 'sonnet',
      effort: 'high',
      confirmed: ['effort']
    })
    expect(record(host)?.options).toEqual({ model: 'sonnet' })

    behavior.optionWritesHang = false
    await setOption(host, 'effort', 'high')
    await setOption(host, 'permissionMode', 'accept-edits')
    expect(record(host)?.options).toEqual({ model: 'sonnet', effort: 'high' })
    expect(record(host)?.permissionMode).toBe('accept-edits')

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
    expect(claude.children(SESSION)).toHaveLength(1)
    expect(claude.child(SESSION).connection.closed).toBe(true)
    await send(host, 'first message')
    await vi.waitFor(() => expect(claude.children(SESSION)).toHaveLength(2))
    expect(claude.child(SESSION).launch.options).toMatchObject({
      sessionId: freshProviderSessionId,
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'acceptEdits'
    })
    expect(claude.child(SESSION).launch.options.resume).toBeUndefined()
    await vi.waitFor(() =>
      expect(record(host)?.options).toEqual({ model: 'sonnet', effort: 'high' })
    )
    expect(record(host)?.permissionMode).toBe('accept-edits')
  })

  it('replaces the launched saved model with the one the user then sets', async () => {
    const behavior = { ...LIVE_START, optionWritesHang: true, controlTimeoutMs: DEADLINE_MS }
    claude.behave(SESSION, behavior)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = await claude.install()
    await expect(
      host.attach(CALLER, claude.attachParams(SESSION, null, { options: { model: 'sonnet' } }))
    ).resolves.toMatchObject({ ok: true })
    await ready(host)
    expect(record(host)?.options).toEqual({ model: 'sonnet' })
    turnReportsModel('claude-sonnet-5')

    behavior.optionWritesHang = false
    await setOption(host, 'model', 'opus')
    expect(record(host)?.options).toEqual({ model: 'opus' })
    expect((await picker(host)).model).toBe('opus')
  })

  it("keeps saved choices empty when startup's settings read goes unanswered", async () => {
    claude.behave(SESSION, { startupSettingsReadHangs: true, controlTimeoutMs: DEADLINE_MS })
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })

    await ready(host)
    expect(record(host)?.options).toBeUndefined()
    expect(record(host)?.lease.claimStatus).toBe('live')
    expect(await statusRows(host)).toEqual([])
    expect(claude.children(SESSION)).toHaveLength(1)
  })
})
