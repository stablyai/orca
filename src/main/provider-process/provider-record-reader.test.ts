import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createProviderRecordReader } from './provider-record-reader'
import { CODEX_AGENT_MESSAGE_DELTA_MERGING } from '../codex/app-server/codex-agent-message-delta-merging'

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
    stdout.write([delta('a', 'He'), delta('a', 'llo'), request, delta('b', 'x')].join('\n') + '\n')
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
})
