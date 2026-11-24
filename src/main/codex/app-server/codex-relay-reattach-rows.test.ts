import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { RelayedProviderOutput } from '../../provider-relay/relayed-provider-output'
import { createCodexRelayAckFloor } from './codex-relay-ack-floor'
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
  it('never acks past the start of a streamed item still open, unless the daemon asks', async () => {
    const acks: number[] = []
    const output = new RelayedProviderOutput({
      stdout: new Readable({ read() {} }),
      ackFloor: createCodexRelayAckFloor(),
      durable: async () => true,
      ack: async (seq) => {
        acks.push(seq)
      }
    })
    output.restartAt(0)
    output.line('relayData', 1, item('item/started', 'a'))
    output.line('relayData', 2, item('item/completed', 'a', 'completed'))
    output.line('relayData', 3, item('item/started', 'b'))
    output.line('relayData', 4, '{"method":"item/agentMessage/delta","params":{"itemId":"b"}}')
    await output.settle()
    // A crash now replays b from its start, so its row is rewritten whole, never cut in two.
    expect(acks).toEqual([2])
    output.line('relayData', 5, item('item/completed', 'b', 'completed'))
    await output.settle()
    expect(acks).toEqual([2, 5])
    output.line('relayData', 6, item('item/started', 'c'))
    await output.settle(true)
    await settle()
    expect(acks).toEqual([2, 5, 6])
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
    expect(tracker.state?.tasks.map((task) => task.kind)).toEqual(['command'])
  })
})
