// A message handed to Claude during a turn: it stays owed work until Claude says its turn is over,
// and one Claude never took is then drawn as sent. Against the production runtime, adapter,
// record store and host, with only the CLI process scripted.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentSessionTurnCompletionEvent } from '../../shared/agent-session-wire'
import { owesStructuredAgentSessionWork } from '../../shared/structured-agent-session-owed-work'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-turn-end-settlement'
const CALLER = { callerKey: 'client-1' }

let claude = createScriptedClaudeRuntime([SESSION])
let operations = 0

afterEach(async () => {
  vi.restoreAllMocks()
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

async function send(host: StructuredAgentSessionHost, text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`,
      expectedRuntimeFence: host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  return sent.value.clientMessageId
}

describe('a Claude turn that ends without taking a message handed to it', () => {
  it.each([false, true])(
    'settles the message in doubt at the result of a CLI that reports no session state (is_error: %s)',
    async (isError) => {
      const host = await claude.install()
      await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
        ok: true
      })
      await send(host, 'write a story')
      const child = claude.child(SESSION)
      await vi.waitFor(() => expect(child.sent).toHaveLength(1))
      const providerSession = String(child.launch.options.sessionId)
      child.handlers.onMessage?.({ ...child.sent[0], uuid: 'user-echo' })
      await host.flushStreamedEvents(SESSION)
      const steer = await send(host, 'make it shorter')
      await vi.waitFor(() => expect(child.sent).toHaveLength(2))

      child.handlers.onMessage?.({
        type: 'result',
        subtype: isError ? 'error_during_execution' : 'success',
        is_error: isError,
        session_id: providerSession,
        uuid: 'result-1'
      })
      await host.flushStreamedEvents(SESSION)

      await vi.waitFor(async () => {
        const snapshot = await host.journalSnapshot(SESSION)
        expect(snapshot.submissions.find((entry) => entry.clientMessageId === steer)).toMatchObject(
          {
            dispatchState: 'unknown',
            reason: 'turn_settled_before_acknowledgement',
            recovered: true
          }
        )
        const fence = host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
        expect(owesStructuredAgentSessionWork(snapshot.items, snapshot.submissions, fence)).toBe(
          false
        )
      })
    }
  )
})

type CapturedEvent =
  | { at: number; kind: 'frame'; frame: Record<string, unknown> }
  | { at: number; kind: 'dispatch'; sentUuid: string; text: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A capture recorded through Orca's adapter against the real CLI (2.1.280), verbatim. */
function loadCapture(name: string): { providerSessionId: string; events: CapturedEvent[] } {
  const lines = readFileSync(
    join(__dirname, '..', 'claude', '__fixtures__', `claude-adapter-capture-${name}.jsonl`),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line))
  let providerSessionId = ''
  const events: CapturedEvent[] = []
  for (const line of lines) {
    if (!isRecord(line) || typeof line.at !== 'number') {
      throw new Error('capture line is not a recorded event')
    }
    if (line.kind === 'meta' && typeof line.providerSessionId === 'string') {
      providerSessionId = line.providerSessionId
    } else if (line.kind === 'frame' && isRecord(line.frame)) {
      events.push({ at: line.at, kind: 'frame', frame: line.frame })
    } else if (
      line.kind === 'dispatch' &&
      typeof line.sentUuid === 'string' &&
      typeof line.text === 'string'
    ) {
      events.push({ at: line.at, kind: 'dispatch', sentUuid: line.sentUuid, text: line.text })
    }
  }
  return { providerSessionId, events }
}

async function owesWork(host: StructuredAgentSessionHost): Promise<boolean> {
  const snapshot = await host.journalSnapshot(SESSION)
  const fence = host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
  return owesStructuredAgentSessionWork(snapshot.items, snapshot.submissions, fence)
}

async function submissionOf(host: StructuredAgentSessionHost, clientMessageId: string) {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

async function attachWithCompletions(): Promise<{
  host: StructuredAgentSessionHost
  completions: string[]
}> {
  const host = await claude.install()
  await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
    ok: true
  })
  const completions: string[] = []
  host.subscribeTurnCompletions({
    id: 'turn-completions',
    emit: (event: AgentSessionTurnCompletionEvent) => {
      if (event.type === 'completion') {
        completions.push(event.completion.turnId)
      }
    }
  })
  return { host, completions }
}

describe('a message Claude runs as its next request cycle', () => {
  // p2-miss: the steer lands too late to fold. result-1 arrives without it, the next cycle's init
  // right after, its echo later — and Claude reports idle only after result-2.
  it('stays owed work from its send to its echo, with no completion in the gap', async () => {
    const { host, completions } = await attachWithCompletions()
    const capture = loadCapture('miss')
    const uuids = new Map<string, string>()
    const clientIds: string[] = []
    let providerSession = ''
    const replay = (frame: Record<string, unknown>): Record<string, unknown> => {
      let text = JSON.stringify(frame).replaceAll(capture.providerSessionId, providerSession)
      for (const [captured, live] of uuids) {
        text = text.replaceAll(captured, live)
      }
      const mapped: unknown = JSON.parse(text)
      if (!isRecord(mapped)) {
        throw new Error('mapped frame is not a record')
      }
      return mapped
    }
    // Frames recorded ahead of the first send reach a child only once a send has spawned it.
    const early: Record<string, unknown>[] = []
    let steerEchoed = false
    for (const event of capture.events) {
      if (event.kind === 'dispatch') {
        clientIds.push(await send(host, event.text))
        const child = claude.child(SESSION)
        await vi.waitFor(() => expect(child.sent).toHaveLength(clientIds.length))
        providerSession = String(child.launch.options.sessionId)
        uuids.set(event.sentUuid, String(child.sent.at(-1)?.uuid))
        for (const frame of early.splice(0)) {
          child.handlers.onMessage?.(replay(frame))
        }
        continue
      }
      if (clientIds.length === 0) {
        early.push(event.frame)
        continue
      }
      claude.child(SESSION).handlers.onMessage?.(replay(event.frame))
      await host.flushStreamedEvents(SESSION)
      const steer = clientIds[1]
      if (steer && !steerEchoed) {
        steerEchoed = (await submissionOf(host, steer))?.dispatchState === 'accepted'
        if (!steerEchoed) {
          // Through result-1 (21085) and the next cycle's init: working, and nothing announced.
          expect(await owesWork(host)).toBe(true)
          expect((await submissionOf(host, steer))?.recovered).toBeUndefined()
          expect(completions).toEqual([])
        }
      }
    }

    expect(steerEchoed).toBe(true)
    await vi.waitFor(async () => expect(await owesWork(host)).toBe(false))
    const [first, steer] = await Promise.all(clientIds.map((id) => submissionOf(host, id)))
    expect(first?.dispatchState).toBe('accepted')
    expect(steer?.dispatchState).toBe('accepted')
  })

  it('settles one Claude never runs at its idle, not at the result before it', async () => {
    const { host, completions } = await attachWithCompletions()
    const first = await send(host, 'write a story')
    const child = claude.child(SESSION)
    await vi.waitFor(() => expect(child.sent).toHaveLength(1))
    const providerSession = String(child.launch.options.sessionId)
    const state = (value: string) => ({
      type: 'system',
      subtype: 'session_state_changed',
      state: value,
      session_id: providerSession,
      uuid: `state-${value}`
    })
    child.handlers.onMessage?.(state('running'))
    child.handlers.onMessage?.({ ...child.sent[0], isReplay: true })
    await host.flushStreamedEvents(SESSION)
    const steer = await send(host, 'make it shorter')
    await vi.waitFor(() => expect(child.sent).toHaveLength(2))

    child.handlers.onMessage?.({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: providerSession,
      uuid: 'result-1',
      user_message_uuid: child.sent[0]?.uuid,
      user_message_uuids: [child.sent[0]?.uuid]
    })
    await host.flushStreamedEvents(SESSION)
    expect((await submissionOf(host, steer))?.dispatchState).toBe('pending')
    expect(await owesWork(host)).toBe(true)
    expect(completions).toEqual([])

    child.handlers.onMessage?.(state('idle'))
    await host.flushStreamedEvents(SESSION)
    await vi.waitFor(async () =>
      expect(await submissionOf(host, steer)).toMatchObject({
        dispatchState: 'unknown',
        reason: 'turn_settled_before_acknowledgement',
        recovered: true
      })
    )
    expect(await owesWork(host)).toBe(false)
    expect((await submissionOf(host, first))?.dispatchState).toBe('accepted')
  })
})
