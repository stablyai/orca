// A Claude start has no deadline of its own, but each option write the restore replays, and
// startup's own settings read, is a control request under the ordinary request deadline. A CLI
// that answers initialize and then never answers one of those used to fault the whole session
// when that deadline fired: a start that was merely slow died with the deadline's error as its
// cause. Now the unanswered request is skipped and startup lands on the CLI's own values, while
// the saved choice stays saved for the next start to retry. Against
// the production runtime, adapter, record store and host, with only the CLI process scripted.

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { claudeSessionIdForOrcaSession } from '../claude/claude-structured-launch-resolution'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-startup-unanswered-control'
const CALLER = { callerKey: 'client-1' }
const DEADLINE_MS = 50

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
  const body = hostTestMessage(text)
  await expect(
    host.send(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`,
        expectedRuntimeFence: record(host)?.lease.runtimeFence ?? 0,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION,
          fields: { body }
        })
      },
      body
    })
  ).resolves.toMatchObject({ ok: true })
}

describe('a Claude start whose CLI answers initialize but not a control request', () => {
  it('lands with the unanswered option write skipped instead of faulting at the deadline, and keeps the saved choice', async () => {
    claude.behave(SESSION, { optionWritesHang: true, controlTimeoutMs: DEADLINE_MS })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = await claude.install()
    const saved = { model: 'sonnet', permissionMode: 'plan' }
    await expect(
      host.attach(CALLER, claude.attachParams(SESSION, null, { options: saved }))
    ).resolves.toMatchObject({ ok: true })

    // The restore asked; the CLI never answered; startup went on without it.
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('set_model'))
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('set_permission_mode'))
    await vi.waitFor(() => expect(record(host)?.lease.claimStatus).toBe('live'), {
      timeout: DEADLINE_MS * 40
    })
    // The live child runs on the CLI's own model; silence is not a refusal, so the saved
    // choice is neither replaced by that value nor dropped, and the next start retries it.
    await vi.waitFor(() => expect(record(host)?.options).toEqual({ ...saved, effort: 'high' }), {
      timeout: DEADLINE_MS * 40
    })
    expect(host.deps.adapter.readOptionRestoreFailures?.(SESSION)).toEqual([])
    expect(await statusRows(host)).toEqual([])
    expect(claude.children(SESSION)).toHaveLength(1)

    // The proven child takes the next message.
    await send(host, 'hello')
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
  })

  it('keeps the unanswered saved choice when the user later changes a different option', async () => {
    const behavior = { optionWritesHang: true, controlTimeoutMs: DEADLINE_MS }
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

  it('replays the unanswered saved model after a turn reports another model, another option changes, and the chat is cleared', async () => {
    const clearOperation = operationId()
    const replacement = `clear-${createHash('sha256')
      .update(JSON.stringify([SESSION, CALLER.callerKey, clearOperation]))
      .digest('hex')
      .slice(0, 40)}`
    claude = createScriptedClaudeRuntime([SESSION, replacement])
    const behavior = { optionWritesHang: true, controlTimeoutMs: DEADLINE_MS }
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
        clientOperationId: clearOperation,
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
      value: { replacementSessionId: replacement }
    })
    // The cleared chat's start replays the saved model rather than the one the turn reported.
    await vi.waitFor(() => expect(claude.child(replacement).calls).toContain('set_model'))
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(replacement)?.options).toEqual({
        model: 'sonnet',
        effort: 'high',
        permissionMode: 'plan'
      })
    )
    expect(record(host)?.options).toEqual({ model: 'sonnet', permissionMode: 'plan' })
  })

  it('replaces the unanswered saved model with the one the user then sets', async () => {
    const behavior = { optionWritesHang: true, controlTimeoutMs: DEADLINE_MS }
    claude.behave(SESSION, behavior)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = await claude.install()
    await expect(
      host.attach(CALLER, claude.attachParams(SESSION, null, { options: { model: 'sonnet' } }))
    ).resolves.toMatchObject({ ok: true })
    // The record holds the saved model from creation; only the start's own report (effort) says
    // startup finished, and an option write before then is refused as still starting.
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
