import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createProviderRecordReader } from './provider-record-reader'
import {
  CODEX_AGENT_MESSAGE_DELTA_MERGING,
  MAX_MERGED_DELTA_CHARS,
  MAX_MERGED_DELTA_RECORDS
} from '../codex/app-server/codex-agent-message-delta-merging'

const delta = (itemId: string, text: string) =>
  JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { threadId: 't', turnId: 'u', itemId, delta: text }
  })

describe('createProviderRecordReader with Codex delta merging', () => {
  it('hands a run on once, in order, never past a pause, counting lines as handed on', async () => {
    let taken = 0
    const stdout = Object.assign(new PassThrough(), {
      relayRecords: { claim: () => {}, taken: () => void taken++, uncounted: () => {} }
    })
    const seen: { record: unknown; takenBefore: number }[] = []
    const reader = createProviderRecordReader({
      stdout,
      merging: CODEX_AGENT_MESSAGE_DELTA_MERGING,
      onRecord: (record) => {
        seen.push({ record, takenBefore: taken })
        // The merged reply applies backpressure, as a full journal queue does.
        if (JSON.stringify(record).includes('Hello')) {
          reader.pause()
        }
      },
      onRejected: () => {},
      onFatal: (error) => {
        throw error
      }
    })
    const request = JSON.stringify({ id: 9, method: 'item/tool/requestUserInput', params: {} })
    stdout.write(`${[delta('a', 'He'), delta('a', 'llo'), request, delta('b', 'x')].join('\n')}\n`)
    await new Promise((resolve) => setImmediate(resolve))

    const merged = JSON.parse(delta('a', 'Hello'))
    expect(seen).toEqual([{ record: merged, takenBefore: 0 }])
    expect(taken).toBe(2)

    reader.resume()
    await new Promise((resolve) => setImmediate(resolve))
    expect(seen.map((entry) => entry.record)).toEqual([
      merged,
      JSON.parse(request),
      JSON.parse(delta('b', 'x'))
    ])
    expect(taken).toBe(4)
  })

  it('keeps a pause applied after a malformed continuation of a run', async () => {
    const stdout = new PassThrough()
    const order: string[] = []
    const reader = createProviderRecordReader({
      stdout,
      merging: CODEX_AGENT_MESSAGE_DELTA_MERGING,
      onRecord: (record) => {
        order.push(JSON.stringify(record).includes('requestUserInput') ? 'request' : 'delta')
        if (order.length === 1) {
          reader.pause()
        }
      },
      onRejected: () => void order.push('rejected'),
      onFatal: (error) => {
        throw error
      }
    })
    const broken = `${delta('a', 'x').slice(0, -2)},}`
    const request = JSON.stringify({ id: 9, method: 'item/tool/requestUserInput', params: {} })
    stdout.write(`${[delta('a', 'He'), broken, request].join('\n')}\n`)
    await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(['delta'])

    reader.resume()
    await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(['delta', 'rejected', 'request'])
  })

  it.each([600, 6_000])(
    'hands a resumed backlog of %i deltas on in bounded runs with every line counted',
    async (lines) => {
      let taken = 0
      // Like a relayed agent's stream: lines pushed while paused wait in its buffer.
      const stdout = Object.assign(new Readable({ read: () => {} }), {
        relayRecords: { claim: () => {}, taken: () => void taken++, uncounted: () => {} }
      })
      const texts: string[] = []
      const reader = createProviderRecordReader({
        stdout,
        merging: CODEX_AGENT_MESSAGE_DELTA_MERGING,
        onRecord: (record) => texts.push(JSON.parse(JSON.stringify(record)).params.delta),
        onRejected: () => {},
        onFatal: (error) => {
          throw error
        }
      })
      reader.pause()
      const sent: string[] = []
      for (let index = 0; index < lines; index++) {
        // Large deltas first, then small ones, so the size cap and then the record cap end runs.
        const text = `<${index}>`.padEnd(index < lines / 2 ? 1024 : 8, 'x')
        sent.push(text)
        stdout.push(`${delta('a', text)}\n`)
      }
      reader.resume()
      for (let turn = 0; turn < 100 && taken < lines; turn++) {
        await new Promise((resolve) => setImmediate(resolve))
      }

      expect(texts.join('')).toBe(sent.join(''))
      expect(taken).toBe(lines)
      expect(Math.max(...texts.map((text) => text.length))).toBeLessThanOrEqual(
        MAX_MERGED_DELTA_CHARS + 1024
      )
      const records = texts.map((text) => text.match(/<\d+>/g)?.length ?? 0)
      expect(Math.max(...records)).toBeLessThanOrEqual(MAX_MERGED_DELTA_RECORDS)
    }
  )
})
