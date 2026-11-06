import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpAgentError } from './acp-errors'
import { GENERIC_ACP_DIALECT } from './acp-dialects/acp-dialect'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'
import { AcpItemOwnership } from './acp-item-ownership'
import { retainedCollectionEntries as retainedEntries } from './acp-ownership-test-support'

afterEach(() => vi.restoreAllMocks())

function permission(lane: AcpTimelineTranslator, callId: string) {
  return lane.request(
    'session/request_permission',
    {
      sessionId: 'session-1',
      toolCall: { toolCallId: callId },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    },
    callId
  ).events
}

function complete(lane: AcpTimelineTranslator, index: number) {
  lane.openPrompt(`send-${index}`, index)
  for (const update of [
    {
      sessionUpdate: 'tool_call',
      toolCallId: `item-${index}`,
      title: 'Read',
      status: 'completed'
    },
    {
      sessionUpdate: 'agent_thought_chunk',
      messageId: `item-${index}`,
      content: { type: 'text', text: ' ' }
    }
  ]) {
    lane.notification(
      'session/update',
      { sessionId: 'session-1', _meta: { promptId: `prompt:send-${index}` }, update },
      index
    )
  }
  lane.promptResult(`send-${index}`, { stopReason: 'end_turn' }, index)
  lane.publication()?.()
}

describe('ACP ownership resource contract', () => {
  it.each([200, 2000])('retires completed history with linear work across %i turns', (turns) => {
    // Prime lazy protocol validators before counting ownership retirement on a fresh translator.
    const warmup = new AcpTimelineTranslator({ sessionId: 'session-1', dialect: GROK_ACP_DIALECT })
    complete(warmup, -1)
    warmup.dispose()
    const lane = new AcpTimelineTranslator({ sessionId: 'session-1', dialect: GROK_ACP_DIALECT })
    const get = Map.prototype.get
    const owner = AcpItemOwnership.prototype.get
    const iterate = Map.prototype[Symbol.iterator]
    const keys = Map.prototype.keys
    const values = Map.prototype.values
    const entries = Map.prototype.entries
    const forEach = Map.prototype.forEach
    let probes = 0
    let visits = 0
    let lookup = false
    vi.spyOn(AcpItemOwnership.prototype, 'get').mockImplementation(function (
      this: AcpItemOwnership,
      key
    ) {
      lookup = true
      try {
        return owner.call(this, key)
      } finally {
        lookup = false
      }
    })
    vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key) {
      probes += Number(lookup)
      return get.call(this, key)
    })
    const counted = <T>(iterator: MapIterator<T>): MapIterator<T> => {
      const next = iterator.next.bind(iterator)
      iterator.next = () => {
        const value = next()
        visits += Number(!value.done)
        return value
      }
      return iterator
    }
    vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
      this: Map<unknown, unknown>
    ) {
      return counted(iterate.call(this))
    })
    vi.spyOn(Map.prototype, 'keys').mockImplementation(function (this: Map<unknown, unknown>) {
      return counted(keys.call(this))
    })
    vi.spyOn(Map.prototype, 'values').mockImplementation(function (this: Map<unknown, unknown>) {
      return counted(values.call(this))
    })
    vi.spyOn(Map.prototype, 'entries').mockImplementation(function (this: Map<unknown, unknown>) {
      return counted(entries.call(this))
    })
    vi.spyOn(Map.prototype, 'forEach').mockImplementation(function (
      this: Map<unknown, unknown>,
      callback,
      thisArg
    ) {
      return forEach.call(this, (value: unknown, key: unknown, map: Map<unknown, unknown>) => {
        visits += 1
        callback.call(thisArg, value, key, map)
      })
    })
    for (let index = 0; index < turns; index += 1) {
      complete(lane, index)
    }
    // Two keys, four own-key phases: capture, payload cleanup, settlement and publication.
    expect(visits).toBeLessThanOrEqual(turns * 2 * 4)
    // Two new-key observations plus one named-owner lookup; each probes at most 3 maps.
    expect(probes).toBeLessThanOrEqual(turns * 3 * 3)
    const beforeMiss = probes
    expect(permission(lane, 'missing')[0]).toMatchObject({ join: { thread: 'session-1' } })
    expect(probes - beforeMiss).toBeLessThanOrEqual(3)
    vi.restoreAllMocks()
    // Existing 128-entry start cache uses two maps; ownership keeps only the last two keys.
    expect(retainedEntries(lane)).toBeLessThanOrEqual(258)
    expect(permission(lane, `item-${turns - 1}`)[0]).toMatchObject({
      join: { turn: `prompt:send-${turns - 1}` }
    })
    expect(permission(lane, 'item-0')[0]).not.toHaveProperty('join.turn')
    lane.dispose()
  })

  it('retains a first late ID only until the next genuine end and leaves refusals empty', () => {
    const lane = new AcpTimelineTranslator({ sessionId: 'session-1', dialect: GROK_ACP_DIALECT })
    lane.openPrompt('seed', 0)
    const oldChunk = {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'settled-message',
      content: { type: 'text', text: 'Seed reply' }
    }
    lane.notification(
      'session/update',
      { sessionId: 'session-1', _meta: { promptId: 'prompt:seed' }, update: oldChunk },
      0
    )
    lane.promptResult('seed', { stopReason: 'end_turn' }, 0)
    lane.publication()?.()
    const baseline = retainedEntries(lane)
    for (let index = 0; index < 2000; index += 1) {
      lane.openPrompt(`refused-${index}`, index)
      expect(
        lane.notification(
          'session/update',
          {
            sessionId: 'session-1',
            _meta: { promptId: `prompt:refused-${index}` },
            update: oldChunk
          },
          index
        )
      ).toEqual([])
      lane.promptRefused(`refused-${index}`, new AcpAgentError(-32603, 'Internal error'))
    }
    expect(retainedEntries(lane)).toBe(baseline)
    lane.openPrompt('first', 1)
    lane.promptResult('first', { stopReason: 'end_turn' }, 2)
    lane.publication()?.()
    lane.openPrompt('next', 3)
    const chunk = {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'late',
      content: { type: 'text', text: ' ' }
    }
    expect(
      lane.notification(
        'session/update',
        { sessionId: 'session-1', _meta: { promptId: 'prompt:first' }, update: chunk },
        4
      )
    ).toEqual([])
    expect(
      lane.notification(
        'session/update',
        {
          sessionId: 'session-1',
          update: { ...chunk, content: { type: 'text', text: 'Old reply' } }
        },
        5
      )
    ).toEqual([])
    lane.publication()?.()
    lane.promptResult('next', { stopReason: 'end_turn' }, 6)
    lane.publication()?.()
    expect(
      lane.notification('session/update', { sessionId: 'session-1', update: chunk }, 7)
    ).toMatchObject([{ type: 'text.delta' }])
    const before = retainedEntries(lane)
    const lateTool = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'late-tool',
      status: 'completed'
    }
    lane.notification(
      'session/update',
      { sessionId: 'session-1', _meta: { promptId: 'prompt:first' }, update: lateTool },
      8
    )
    lane.publication()?.()
    expect(retainedEntries(lane)).toBe(before)
    lane.dispose()
  })

  it.each([200, 2000])(
    'retires superseded provider turns without needing %i missing end events',
    (turns) => {
      const ended = new Set<string>()
      const lane = new AcpTimelineTranslator({
        sessionId: 'session-1',
        dialect: GROK_ACP_DIALECT,
        ownership: {
          tool: () => undefined,
          message: () => undefined,
          settled: (turn) => ended.has(turn)
        }
      })
      for (let index = 0; index < turns; index += 1) {
        const turn = `external-${index}`
        lane.notification(
          'session/update',
          {
            sessionId: 'session-1',
            _meta: { promptId: turn },
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Reply' }
            }
          },
          index
        )
        if (index > 0) {
          ended.add(`external-${index - 1}`)
        }
        lane.publication()?.()
      }
      // Two 128-entry start maps, one live turn descriptor and its anonymous position.
      expect(retainedEntries(lane)).toBeLessThanOrEqual(258)
      lane.dispose()
    }
  )

  it('keeps uncapped live populations through older publication callbacks', () => {
    const lane = new AcpTimelineTranslator({ sessionId: 'session-1', dialect: GENERIC_ACP_DIALECT })
    lane.openPrompt('first', 1)
    for (let index = 0; index < 160; index += 1) {
      lane.notification(
        'session/update',
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `t-${index}`,
            title: 'Read',
            status: 'in_progress'
          }
        },
        2
      )
    }
    const oldPublication = lane.publication()
    lane.promptResult('first', { stopReason: 'end_turn' }, 3)
    lane.openPrompt('second', 4)
    lane.promptResult('second', { stopReason: 'end_turn' }, 5)
    oldPublication?.()
    expect(permission(lane, 't-0')[0]).toMatchObject({ join: { turn: 'prompt:first' } })
    lane.publication()?.()
    expect(permission(lane, 't-0')[0]).not.toHaveProperty('join.turn')
    lane.openPrompt('pending', 6)
    lane.promptResult('pending', { stopReason: 'end_turn' }, 7)
    const delayed = lane.publication()
    expect(delayed).toBeTypeOf('function')
    lane.dispose()
    delayed?.()
  })
})
