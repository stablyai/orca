// A chat's saved model rides the launch unchecked. A missing-model reply retires the live child's
// choice; provider reports leave the saved pick alone. Against the production runtime, adapter,
// record store and host, with only the CLI process scripted.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { claudeSessionIdForOrcaSession } from '../claude/claude-structured-launch-resolution'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-retired-saved-model'
const CALLER = { callerKey: 'client-1' }
const RETIRED = 'claude-retired-1'

let claude = createScriptedClaudeRuntime([SESSION])

afterEach(async () => {
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

/** The reply Claude Code 2.1.280 sends when its `--model` names a model that does not exist. */
function modelNotFoundReply(uuid: string, parentToolUseId: string | null = null) {
  return {
    type: 'assistant',
    uuid,
    session_id: claudeSessionIdForOrcaSession(SESSION),
    parent_tool_use_id: parentToolUseId,
    error: 'model_not_found',
    is_api_error_message: true,
    message: {
      model: '<synthetic>',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `There's an issue with the selected model (${RETIRED}). It may not exist or you may not have access to it.`
        }
      ]
    }
  }
}

async function startedWith(options: Record<string, string>): Promise<StructuredAgentSessionHost> {
  claude.behave(SESSION, { sendsNoStartFrame: true })
  const host = await claude.install()
  await expect(
    host.attach(CALLER, claude.attachParams(SESSION, null, { options }))
  ).resolves.toMatchObject({ ok: true })
  await vi.waitFor(() =>
    expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
  )
  return host
}

describe("a Claude chat whose saved model the CLI says doesn't exist", () => {
  it('keeps the saved pick while the live child retires its missing model', async () => {
    const host = await startedWith({ model: RETIRED, effort: 'high' })
    expect(claude.child(SESSION).launch.options.model).toBe(RETIRED)
    expect(host.deps.store.getRecord(SESSION)?.options?.model).toBe(RETIRED)

    claude.child(SESSION).handlers.onMessage?.(modelNotFoundReply('reply-1'))
    await host.flushStreamedEvents(SESSION)
    expect(host.deps.store.getRecord(SESSION)?.options).toMatchObject({
      model: RETIRED,
      effort: 'high'
    })
    // The picker shows what the child runs now, so the next send moves the chat off the model.
    await vi.waitFor(async () =>
      expect((await host.readOptions(SESSION, { readsWithoutModel: true })).current.model).not.toBe(
        RETIRED
      )
    )
  })

  it("keeps a model the reply did not come from: a subagent's own error", async () => {
    const host = await startedWith({ model: RETIRED })

    claude.child(SESSION).handlers.onMessage?.(modelNotFoundReply('reply-1', 'toolu_subagent'))
    await host.flushStreamedEvents(SESSION)

    expect(host.deps.store.getRecord(SESSION)?.options?.model).toBe(RETIRED)
  })

  // The CLI's word is about the model it was launched with; a pick made since is the user's.
  it('keeps a model the user picked while the heal was on its way', async () => {
    const host = await startedWith({ model: RETIRED })
    const record = () => host.deps.store.getRecord(SESSION)
    const changed = await host.setOption(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: `${Date.now()}-${'1'.padStart(32, '0')}`,
        expectedRuntimeFence: record()?.lease.runtimeFence ?? 0,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId: SESSION,
          fields: { key: 'model', value: 'opus' }
        })
      },
      key: 'model',
      value: 'opus'
    })
    expect(changed, JSON.stringify(changed)).toMatchObject({ ok: true })
    expect(record()?.options?.model).toBe('opus')
    claude.child(SESSION).handlers.onMessage?.(modelNotFoundReply('reply-1'))
    await host.flushStreamedEvents(SESSION)
    expect(record()?.options?.model).toBe('opus')
  })

  // A slow settings readback can report the retired live model after the error.
  it('leaves the saved pick alone when that settings report arrives late', async () => {
    claude.behave(SESSION, {
      sendsNoStartFrame: true,
      startupSettingsReadHangs: true,
      controlTimeoutMs: 300
    })
    const host = await claude.install()
    const reports = vi.spyOn(host, 'handleAdapterEvent')
    await expect(
      host.attach(CALLER, claude.attachParams(SESSION, null, { options: { model: RETIRED } }))
    ).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
    )
    claude.child(SESSION).handlers.onMessage?.({
      type: 'system',
      subtype: 'init',
      session_id: claudeSessionIdForOrcaSession(SESSION),
      model: RETIRED
    })
    claude.child(SESSION).handlers.onMessage?.(modelNotFoundReply('reply-1'))
    await host.flushStreamedEvents(SESSION)
    expect(host.deps.store.getRecord(SESSION)?.options?.model).toBe(RETIRED)

    // The settings read gives up at its deadline and reports what the child showed.
    await vi.waitFor(
      () => expect(reports.mock.calls.map(([event]) => event.type)).toContain('options-reported'),
      { timeout: 5_000 }
    )
    await host.flushStreamedEvents(SESSION)
    expect(host.deps.store.getRecord(SESSION)?.options?.model).toBe(RETIRED)
  })
})
