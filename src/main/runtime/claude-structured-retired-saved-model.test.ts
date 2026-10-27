// Missing-model replies retire the live choice; provider reports must preserve the saved user pick.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { claudeSessionIdForOrcaSession } from '../claude/claude-structured-launch-resolution'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'
import { structuredAgentSessionSeedCatalog } from '../../shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../shared/structured-agent-session-options'
import { structuredAgentSessionSendSelection } from '../../shared/structured-agent-session-option-view'

const SESSION = 'claude-retired-saved-model'
const CALLER = { callerKey: 'client-1' }
const RETIRED = 'claude-retired-1'

let claude = createScriptedClaudeRuntime([SESSION])

afterEach(async () => {
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

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
  it.each([undefined, 'opus[1m]'])(
    'keeps the saved pick and applies the replacement %s after an unsolicited model error',
    async (replacement) => {
      const host = await startedWith({ model: RETIRED, effort: 'high' })
      expect(claude.child(SESSION).launch.options.model).toBe(RETIRED)
      expect(host.deps.store.getRecord(SESSION)?.options?.model).toBe(RETIRED)

      claude.child(SESSION).handlers.onMessage?.(modelNotFoundReply('reply-1'))
      await host.flushStreamedEvents(SESSION)
      expect(host.deps.store.getRecord(SESSION)?.options).toMatchObject({
        model: RETIRED,
        effort: 'high'
      })
      const live = await host.deps.adapter.readOptions?.({
        sessionId: SESSION,
        fence: host.deps.store.getRecord(SESSION)!.lease.runtimeFence
      })
      expect(live).toMatchObject({ current: { model: undefined } })
      const answer = await vi.waitFor(async () => {
        const read = await host.readOptions(SESSION, { readsWithoutModel: true })
        expect(read.current.model).not.toBe(RETIRED)
        expect(read.current).toMatchObject({ model: 'sonnet', defaulted: [] })
        return read
      })
      const seed = structuredAgentSessionSeedCatalog('claude')
      const reopened = applyStructuredAgentSessionOptions(
        createStructuredAgentSessionOptionState('claude', seed),
        seed,
        answer
      )
      const options = {
        ...structuredAgentSessionSendSelection(reopened),
        ...(replacement ? { model: replacement } : {})
      }
      expect(options).toEqual({ model: replacement ?? answer.current.model, effort: 'high' })
      const dispatch = vi.spyOn(host.deps.adapter, 'dispatch')
      const connection = claude.child(SESSION).connection
      let appliedModel: string | undefined = 'sonnet'
      const originalSetModel = connection.setModel
      const setModel = vi
        .spyOn(connection, 'setModel')
        .mockImplementation(async (model, options) => {
          await originalSetModel(model, options)
          appliedModel = model
        })
      const originalSend = connection.send
      const modelsAtWrite: (string | undefined)[] = []
      vi.spyOn(connection, 'send').mockImplementation(async (message, prepare) => {
        await prepare?.()
        modelsAtWrite.push(appliedModel)
        return originalSend(message)
      })
      const body = hostTestMessage('try the replacement')
      const sent = await host.send(CALLER, {
        envelope: {
          sessionId: SESSION,
          clientOperationId: `${Date.now()}-${'2'.padStart(32, '0')}`,
          expectedRuntimeFence: host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: SESSION,
            fields: { body, options }
          })
        },
        body,
        options
      })
      expect(sent).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
      expect(dispatch.mock.calls[0]?.[0].executionOptions).toEqual({
        model: replacement ?? answer.current.model,
        effort: 'high'
      })
      expect(setModel.mock.calls.map(([model]) => model)).toEqual([
        replacement ?? answer.current.model
      ])
      expect(modelsAtWrite).toEqual([replacement ?? answer.current.model])
      expect(host.deps.store.getRecord(SESSION)?.options).toMatchObject({
        model: RETIRED,
        effort: 'high'
      })
    }
  )

  it("keeps a model the reply did not come from: a subagent's own error", async () => {
    const host = await startedWith({ model: RETIRED })

    claude.child(SESSION).handlers.onMessage?.(modelNotFoundReply('reply-1', 'toolu_subagent'))
    await host.flushStreamedEvents(SESSION)

    expect(host.deps.store.getRecord(SESSION)?.options?.model).toBe(RETIRED)
    const live = await host.deps.adapter.readOptions?.({
      sessionId: SESSION,
      fence: host.deps.store.getRecord(SESSION)!.lease.runtimeFence
    })
    expect(live).toMatchObject({ current: { model: RETIRED } })
    expect(claude.child(SESSION).calls).not.toContain('set_model')
  })

  // A concurrent user pick outranks the launch model's failure.
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

    await vi.waitFor(
      () => expect(reports.mock.calls.map(([event]) => event.type)).toContain('options-reported'),
      { timeout: 5_000 }
    )
    await host.flushStreamedEvents(SESSION)
    expect(host.deps.store.getRecord(SESSION)?.options?.model).toBe(RETIRED)
  })
})
