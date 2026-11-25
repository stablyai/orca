import { describe, expect, it } from 'vitest'
import {
  RELAY_CUT_KEYS_OVERFLOW,
  type ProviderRelayAttachResult
} from '../../../daemon/protocol/daemon-provider-relay-protocol'
import { attachContinuation } from '../../../provider-relay/relayed-provider-continuation'
import { AcpRelayItemContinuation } from '../acp-relay-item-continuation'

const update = (fields: Record<string, unknown>) =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 's', update: fields }
  })
const chunk = (messageId: string, text: string) =>
  update({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } })
const idOf = (line: string): unknown => JSON.parse(line).params.update.messageId

const attach = (
  outstanding: ProviderRelayAttachResult['outstanding'],
  truncatedThrough?: number
): ProviderRelayAttachResult => ({
  replayThroughSeq: 16,
  pending: [],
  maxClientRequestId: 7,
  initializeResultSent: true,
  stderrTail: '',
  exit: null,
  ...(outstanding ? { outstanding } : {}),
  ...(truncatedThrough === undefined ? {} : { truncatedThrough })
})

describe('ACP relay item continuation', () => {
  it('moves only the message a cut replay starts inside, the same way on every attach, until the prompt is answered', () => {
    const hook = new AcpRelayItemContinuation()
    const replay = [
      chunk('m1', 'tail'),
      chunk('m1', 'more'),
      update({ sessionUpdate: 'tool_call', toolCallId: 'c1' }),
      chunk('m2', 'whole'),
      JSON.stringify({ jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } }),
      chunk('m3', 'next turn')
    ]
    const run = () => {
      hook.reset()
      // The daemon dropped kept lines through 10, past the prompt's start.
      const cut = attachContinuation(
        hook,
        'r1',
        10,
        attach([{ id: 7, method: 'session/prompt' }], 10)
      )
      return replay.map((line, at) => {
        const [out = ''] = cut?.lines(11 + at, line, undefined) ?? [line]
        return out.includes('session/update') ? idOf(out) : 'answer'
      })
    }
    const first = run()
    expect(first).toEqual(['relay:r1:11:m1', 'relay:r1:11:m1', undefined, 'm2', 'answer', 'm3'])
    expect(run()).toEqual(first)
    // A replay the daemon didn't cut starts at each open item's first line: nothing moves.
    expect(
      attachContinuation(hook, 'r1', 10, attach([{ id: 7, method: 'session/prompt' }]))
    ).toBeNull()
  })

  it("moves each session's cut message, however their lines interleave", () => {
    const hook = new AcpRelayItemContinuation()
    const child = (fields: Record<string, unknown>) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'opencode/session/child_update',
        params: { rootSessionId: 's', childSessionId: 'c', type: 'update', update: fields }
      })
    const text = { type: 'text', text: 'x' }
    const replay = [
      child({ sessionUpdate: 'agent_message_chunk', messageId: 'k1', content: text }),
      chunk('m1', 'root tail'),
      child({ sessionUpdate: 'agent_message_chunk', messageId: 'k2', content: text })
    ]
    const cut = attachContinuation(
      hook,
      'r1',
      10,
      attach([{ id: 7, method: 'session/prompt' }], 10)
    )
    const ids = replay.map((line, at) => {
      const [out = ''] = cut?.lines(11 + at, line, undefined) ?? [line]
      return JSON.parse(out).params.update.messageId
    })
    // Each session's first message is its cut one; a later one of the child starts whole.
    expect(ids).toEqual(['relay:r1:11:k1', 'relay:r1:12:m1', 'k2'])
  })

  it("keeps moving a subagent's cut message after its parent prompt is answered", () => {
    const hook = new AcpRelayItemContinuation(true)
    const child = (fields: Record<string, unknown>) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'opencode/session/child_update',
        params: { rootSessionId: 's', childSessionId: 'c', type: 'update', update: fields }
      })
    const text = { type: 'text', text: 'x' }
    const tail = child({ sessionUpdate: 'agent_message_chunk', messageId: 'k1', content: text })
    const result = {
      ...attach([{ id: 7, method: 'session/prompt' }], 10),
      openWork: { subagent: [['c']] }
    }
    const cut = attachContinuation(hook, 'r1', 10, result)
    const replay = [tail, JSON.stringify({ jsonrpc: '2.0', id: 7, result: {} }), tail]
    const ids = replay.map((line, at) => {
      const [out = ''] = cut?.lines(11 + at, line, undefined) ?? [line]
      return JSON.parse(out).params?.update?.messageId ?? 'answer'
    })
    expect(ids).toEqual(['relay:r1:11:k1', 'answer', 'relay:r1:11:k1'])
    expect(cut?.done).toBe(false)
  })

  it('moves exactly the messages the cut named, wherever they come in the replay', () => {
    const hook = new AcpRelayItemContinuation()
    const named = {
      ...attach([{ id: 7, method: 'session/prompt' }], 10),
      cutKeys: [JSON.stringify(['s', 'm1'])]
    }
    const cut = attachContinuation(hook, 'r1', 10, named)
    const replay = [
      update({ sessionUpdate: 'tool_call', toolCallId: 'c1' }),
      chunk('m2', 'new, already saved'),
      chunk('m1', 'resumed tail')
    ]
    const ids = replay.map((line, at) => {
      const [out = ''] = cut?.lines(11 + at, line, undefined) ?? [line]
      return idOf(out)
    })
    expect(ids).toEqual([undefined, 'm2', 'relay:r1:13:m1'])
  })

  it('moves every message a cut meets when it cut more than it could name', () => {
    const hook = new AcpRelayItemContinuation()
    const overflowing = {
      ...attach([{ id: 7, method: 'session/prompt' }], 10),
      cutKeys: [JSON.stringify(['s', 'm1']), RELAY_CUT_KEYS_OVERFLOW]
    }
    const cut = attachContinuation(hook, 'r1', 10, overflowing)
    const replay = [chunk('m2', 'r'), chunk('m3', 'resumed tail')]
    const ids = replay.map((line, at) => idOf(cut?.lines(11 + at, line, undefined)?.[0] ?? line))
    expect(ids).toEqual(['relay:r1:11:m2', 'relay:r1:12:m3'])
  })

  it('moves a named message that resumes only after the replay, until its prompt is answered', () => {
    const hook = new AcpRelayItemContinuation()
    const named = {
      ...attach([{ id: 7, method: 'session/prompt' }], 10),
      cutKeys: [JSON.stringify(['s', 'm1'])]
    }
    const cut = attachContinuation(hook, 'r1', 10, named)
    for (let seq = 11; seq <= 16; seq += 1) {
      cut?.lines(seq, chunk('m2', `b${seq}`), undefined)
    }
    // m1 was paused by a call before the quit; it resumes live, after the replay.
    expect(cut?.done).toBe(false)
    const [resumed = ''] = cut?.lines(20, chunk('m1', 'resumed'), undefined) ?? []
    expect(idOf(resumed)).toBe('relay:r1:20:m1')
    cut?.lines(
      21,
      JSON.stringify({ jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } }),
      undefined
    )
    // The app's turns end the prompt it adopted, so nothing running at the attach resumes.
    hook.agentTurnEnded()
    expect(cut?.done).toBe(true)
  })

  it('stops after the replay once the turn running at attach ended, though a subagent runs on', () => {
    const hook = new AcpRelayItemContinuation(true)
    const named = {
      ...attach(undefined, 10),
      cutKeys: [JSON.stringify(['s', 'm1'])],
      openWork: { subagent: [['child-1']] }
    }
    const cut = attachContinuation(hook, 'r1', 10, named)
    for (let seq = 11; seq <= 16; seq += 1) {
      cut?.lines(seq, chunk('m2', `b${seq}`), undefined)
    }
    // An agent-started turn may still be running: m1 could resume in it.
    expect(cut?.done).toBe(false)
    hook.agentTurnEnded()
    expect(cut?.done).toBe(true)
  })

  it('keeps moving after the replay while open work runs, when the cut named fewer than it split', () => {
    const hook = new AcpRelayItemContinuation(true)
    const overflowing = {
      ...attach(undefined, 10),
      cutKeys: [JSON.stringify(['s', 'm1']), RELAY_CUT_KEYS_OVERFLOW],
      openWork: { subagent: [['child-1']] }
    }
    const cut = attachContinuation(hook, 'r1', 10, overflowing)
    for (let seq = 11; seq <= 16; seq += 1) {
      cut?.lines(seq, update({ sessionUpdate: 'available_commands_update' }), undefined)
    }
    // An unnamed message of the running subagent may still resume.
    expect(cut?.done).toBe(false)
    const [resumed = ''] = cut?.lines(20, chunk('m9', 'resumed'), undefined) ?? []
    expect(idOf(resumed)).toBe('relay:r1:20:m9')
  })
})
