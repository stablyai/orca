import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { RelayedProviderOutput } from '../../provider-relay/relayed-provider-output'
import { createCodexRelayAckFloor } from './codex-relay-ack-floor'
import { CODEX_RELAY_ITEM_CONTINUATION } from './codex-relay-item-continuation'
import {
  restateKeptCodexBackgroundWork,
  seedKeptCodexTurnOrdinals
} from '../structured/threads/codex-kept-turn-ordinals'
import { CodexBackgroundTaskTracker } from '../structured/background-work/codex-background-task-tracker'
import { CodexTurnOrdinals } from '../structured/journal/codex-turn-ordinals'

const item = (method: string, id: string, status = 'inProgress') =>
  JSON.stringify({ method, params: { threadId: 't', item: { type: 'agentMessage', id, status } } })
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('codex rows across a reattach', () => {
  it('keeps a streamed item still open from its start, unless the daemon asks', async () => {
    const acks: string[] = []
    const output = new RelayedProviderOutput({
      stdout: new Readable({ read() {} }),
      ackFloor: createCodexRelayAckFloor(),
      durable: async () => true,
      ack: async (seq, keepFrom) => {
        acks.push(keepFrom === undefined ? `${seq}` : `${seq} keep ${keepFrom}`)
      }
    })
    output.restartAt(0)
    output.line('relayData', 1, item('item/started', 'a'))
    output.line('relayData', 2, item('item/completed', 'a', 'completed'))
    output.line('relayData', 3, item('item/started', 'b'))
    output.line('relayData', 4, '{"method":"item/agentMessage/delta","params":{"itemId":"b"}}')
    await output.settle()
    // A crash now replays b from its start, so its row is rewritten whole, never cut in two.
    expect(acks).toEqual(['4 keep 3'])
    output.line('relayData', 5, item('item/completed', 'b', 'completed'))
    await output.settle()
    expect(acks).toEqual(['4 keep 3', '5'])
    output.line('relayData', 6, item('item/started', 'c'))
    await output.settle(true)
    await settle()
    // The daemon's first ask (its memory cap) starts keeping c rather than release it.
    expect(acks).toEqual(['4 keep 3', '5', '6 keep 6'])
  })

  it('never keeps from a floor a forced ack gave up, and an ask before any keep starts keeping', async () => {
    const acks: string[] = []
    const output = new RelayedProviderOutput({
      stdout: new Readable({ read() {} }),
      ackFloor: createCodexRelayAckFloor(),
      durable: async () => true,
      ack: async (seq, keepFrom) => {
        acks.push(keepFrom === undefined ? `${seq}` : `${seq} keep ${keepFrom}`)
      }
    })
    output.restartAt(0)
    output.line('relayData', 1, item('item/started', 'a'))
    output.line('relayData', 2, '{"method":"item/agentMessage/delta","params":{"itemId":"a"}}')
    await output.settle()
    // At the daemon's file cap the kept span is released; a's start is gone from the spool.
    await output.settle(true)
    output.line('relayData', 3, '{"method":"item/agentMessage/delta","params":{"itemId":"a"}}')
    await output.settle()
    expect(acks).toEqual(['2 keep 1', '2', '3'])
    // Once a is done, the next item is kept from its start again.
    output.line('relayData', 4, item('item/completed', 'a', 'completed'))
    output.line('relayData', 5, item('item/started', 'b'))
    await output.settle()
    expect(acks).toEqual(['2 keep 1', '2', '3', '5 keep 5'])
  })

  it('moves an item a cap-cut replay starts inside to one continuation row, the same on every attach', async () => {
    const delta = (id: string) =>
      JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 't', itemId: id } })
    const attach = async () => {
      const stdout = new Readable({ read() {} })
      const seen: string[] = []
      stdout.on('data', (chunk: Buffer) => seen.push(...chunk.toString().trim().split('\n')))
      const acks: string[] = []
      const output = new RelayedProviderOutput({
        stdout,
        ackFloor: createCodexRelayAckFloor(),
        passWhileHeld: () => false,
        durable: async () => true,
        ack: async (seq, keepFrom) => {
          acks.push(`${seq} keep ${keepFrom}`)
        }
      })
      output.restartAt(10)
      // a started before the daemon dropped lines through 10; b starts inside the replay.
      output.line('relayData', 11, delta('a'))
      output.line('relayData', 12, item('item/started', 'b'))
      output.line('relayData', 13, delta('b'))
      output.continueAfterTruncation(CODEX_RELAY_ITEM_CONTINUATION, 'r1', 10)
      await output.release()
      await settle()
      await output.settle()
      const ids = seen.map((line) => {
        const { params } = JSON.parse(line) as {
          params: { itemId?: string; item?: { id: string } }
        }
        return params.itemId ?? params.item?.id
      })
      return { ids, acks }
    }
    const first = await attach()
    // a's saved row keeps its text; the cut part goes to its own row. b, whole, keeps its id.
    expect(first.ids).toEqual(['relay:r1:11:a', 'b', 'b'])
    // The continuation is kept from its first line, so the next attach replays it whole again.
    expect(first.acks).toEqual(['13 keep 11'])
    const second = await attach()
    expect(second.ids).toEqual(first.ids)
  })

  it("numbers a kept chat's and its subagents' running turns as the live run did", async () => {
    const turns: Record<string, unknown> = {
      main: {
        id: 'turn-1',
        status: 'inProgress',
        items: [
          { type: 'userMessage', id: 'u1' },
          { type: 'commandExecution', id: 'c1' },
          { type: 'agentMessage', id: 'm1' },
          { type: 'collabAgentToolCall', id: 'x', tool: 'spawnAgent', receiverThreadIds: ['sub'] }
        ]
      },
      sub: { id: 'turn-s', status: 'inProgress', items: [{ type: 'agentMessage', id: 's1' }] }
    }
    const ordinals = new CodexTurnOrdinals()
    await seedKeptCodexTurnOrdinals({
      connection: {
        request: async (_method: string, params: unknown) => ({
          data: [turns[(params as { threadId: string }).threadId]]
        })
      } as never,
      translator: {
        seedTurnOrdinals: (threadId, turnId, ids) =>
          ids.forEach((id) => ordinals.ordinalFor(threadId, turnId, id))
      },
      threadId: 'main',
      timeoutMs: 1_000
    })
    // A replayed message keeps its number; the next new one follows, never taking an earlier row.
    expect(ordinals.ordinalFor('main', 'turn-1', 'm1')).toBe(1)
    expect(ordinals.ordinalFor('main', 'turn-1', 'm2')).toBe(2)
    expect(ordinals.ordinalFor('sub', 'turn-s', 's2')).toBe(1)
  })

  it('restates a command that ended while no app was attached, so its replayed end settles it', () => {
    const tracker = new CodexBackgroundTaskTracker('main')
    const turn = {
      threadId: 'main',
      turnId: 'turn-1',
      status: 'completed',
      items: [{ type: 'commandExecution', id: 'c1', status: 'completed', command: 'npm test' }]
    }
    restateKeptCodexBackgroundWork(tracker, [turn], [['main', 'c1']])
    expect(tracker.relayOpenWork(false).command).toEqual([['main', 'c1']])
    tracker.observe({
      method: 'item/completed',
      threadId: 'main',
      params: { turnId: 'turn-1', item: { ...turn.items[0], exitCode: 0 } }
    })
    expect(tracker.relayOpenWork(false).command ?? []).toEqual([])
  })

  it('restates a background command that outlived its turn before the reattach, so it reads live', () => {
    const tracker = new CodexBackgroundTaskTracker('main')
    restateKeptCodexBackgroundWork(tracker, [
      {
        threadId: 'main',
        turnId: 'turn-1',
        status: 'completed',
        items: [
          { type: 'commandExecution', id: 'c1', status: 'inProgress', command: 'npm run dev' }
        ]
      }
    ])
    expect(tracker.relayOpenWork(false).command).toEqual([['main', 'c1']])
    expect(tracker.state?.tasks?.map((task) => task.kind)).toEqual(['command'])
  })
})
