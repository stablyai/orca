// A failed model choice stays selected until the user picks another model.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { claudeSessionIdForOrcaSession } from '../claude/structured/claude-structured-session-id'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'

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
  it('writes one failure per complete CLI sequence, keeps the model on retry, and recovers after a pick', async () => {
    const host = await startedWith({ model: RETIRED, effort: 'high' })
    const record = () => host.deps.store.getRecord(SESSION)!
    const connection = claude.child(SESSION).connection
    const setModel = vi.spyOn(connection, 'setModel')
    const writes = vi.spyOn(connection, 'send')
    const send = async (text: string) => {
      const before = claude.child(SESSION).calls.filter((call) => call === 'send').length
      const body = hostTestMessage(text)
      const sent = await host.send(CALLER, {
        envelope: {
          sessionId: SESSION,
          clientOperationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`,
          expectedRuntimeFence: record().lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: SESSION,
            fields: { body }
          })
        },
        body
      })
      expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true })
      await vi.waitFor(() =>
        expect(claude.child(SESSION).calls.filter((call) => call === 'send')).toHaveLength(
          before + 1
        )
      )
      const written = writes.mock.calls.at(-1)![0]
      claude
        .child(SESSION)
        .handlers.onMessage?.({ ...written, session_id: claudeSessionIdForOrcaSession(SESSION) })
      return written.uuid
    }
    const capturedResult = readFileSync(
      new URL('../claude/__fixtures__/claude-lifecycle-capture-auth-failed.jsonl', import.meta.url),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) =>
        z.object({ frame: z.record(z.string(), z.unknown()).optional() }).parse(JSON.parse(line))
      )
      .find((entry) => entry.frame?.type === 'result')?.frame
    expect(capturedResult).toBeDefined()
    // Reuse the captured API-error envelope with this model error's text and submission identity.
    const result = (id: string, isError: boolean, userMessageUuid: unknown) => ({
      ...capturedResult,
      type: 'result',
      subtype: 'success',
      uuid: `result-${id}`,
      session_id: claudeSessionIdForOrcaSession(SESSION),
      user_message_uuid: userMessageUuid,
      user_message_uuids: [userMessageUuid],
      is_error: isError,
      terminal_reason: isError ? 'api_error' : 'end_turn',
      result: isError ? `There's an issue with the selected model (${RETIRED}).` : 'ok'
    })
    const rows = async () => {
      await host.flushStreamedEvents(SESSION)
      return (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
    }
    for (const id of ['first', 'retry']) {
      const userMessageUuid = await send(id)
      // The existing 2.1.280 model-error fixture followed by the captured API-error result shape.
      claude
        .child(SESSION)
        .handlers.onMessage?.({ ...modelNotFoundReply(id), user_message_uuid: userMessageUuid })
      claude.child(SESSION).handlers.onMessage?.(result(id, true, userMessageUuid))
      const items = await rows()
      const failures = items.filter(
        (row) => row.body.kind === 'status' && row.body.failure?.kind === 'modelUnavailable'
      )
      expect(failures).toHaveLength(id === 'first' ? 1 : 2)
      expect(failures.at(-1)?.body).toMatchObject({
        text: `Claude couldn't use ${RETIRED}. Pick another model and send again.`
      })
      expect(
        items.filter((row) => row.body.kind === 'message' && row.body.role === 'assistant')
      ).toHaveLength(0)
      expect(
        items.filter((row) => row.body.kind === 'status' && row.body.tone === 'error')
      ).toHaveLength(failures.length)
      expect(items.flatMap((row) => readAgentJournalTurn(row.body) ?? []).at(-1)).toMatchObject({
        state: 'completed',
        outcome: 'failure'
      })
      expect(record().options).toMatchObject({ model: RETIRED, effort: 'high' })
      expect((await host.readOptions(SESSION, { readsWithoutModel: true })).current.model).toBe(
        RETIRED
      )
      expect(setModel.mock.calls.every(([model]) => model !== undefined)).toBe(true)
    }
    const fields = { key: 'model', value: 'opus[1m]' }
    const picked = await host.setOption(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`,
        expectedRuntimeFence: record().lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId: SESSION,
          fields
        })
      },
      ...fields
    })
    expect(picked, JSON.stringify(picked)).toMatchObject({ ok: true })
    const recoveredUuid = await send('recovered')
    claude.child(SESSION).handlers.onMessage?.({
      ...modelNotFoundReply('recovered'),
      user_message_uuid: recoveredUuid,
      error: undefined,
      is_api_error_message: false,
      message: { model: 'opus[1m]', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }
    })
    claude.child(SESSION).handlers.onMessage?.(result('recovered', false, recoveredUuid))
    const items = await rows()
    expect(items.flatMap((row) => readAgentJournalTurn(row.body) ?? []).at(-1)).toMatchObject({
      state: 'completed',
      outcome: 'success'
    })
    expect(record().options?.model).toBe('opus[1m]')
    expect(setModel).toHaveBeenLastCalledWith('opus[1m]', expect.anything())
  })

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
  it("keeps a newer user pick when the earlier model's failure arrives", async () => {
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
