import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runLegacyTranscriptImportWorker } from './journal-legacy-import-worker'
import { createLegacyImportTestWorker } from './journal-legacy-import-worker-test-fixture'
import type {
  LegacyImportWorkerMessage,
  LegacyTranscriptImportRequest
} from './journal-legacy-import-worker-protocol'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-import-transfer-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const request = (filePath: string): LegacyTranscriptImportRequest => ({
  agent: 'claude',
  transcriptAgent: 'claude',
  sessionId: 'session',
  filePath,
  limits: { inlineHeadBytes: 16384 },
  validateSource: false
})

it.each([100, 1000])(
  'paces %i retained records without multiplying their transfer',
  async (count) => {
    const filePath = join(root, 'claude.jsonl')
    const rows = Array.from({ length: count }, (_, index) =>
      JSON.stringify({
        type: 'assistant',
        uuid: `row-${index}`,
        message: {
          content: [
            {
              type: 'tool_use',
              id: `call-${index}`,
              name: 'test',
              input: { rows: Array.from({ length: 30 }, () => []) }
            }
          ]
        }
      })
    )
    rows.push(
      JSON.stringify({
        type: 'assistant',
        uuid: 'large',
        message: {
          content: Array.from({ length: 20 }, () => ({ type: 'text', text: 'x'.repeat(4096) }))
        }
      })
    )
    await writeFile(filePath, `${rows.join('\n')}\n`)
    let outstanding = 0
    let maximumOutstanding = 0
    let yieldedIndex = -1
    let allCreditsAfterYield = true
    const batches: Extract<LegacyImportWorkerMessage, { type: 'items' }>[] = []
    const prepared = await runLegacyTranscriptImportWorker(
      request(filePath),
      async () => {},
      undefined,
      (input) => {
        const worker = createLegacyImportTestWorker(input)
        const post = worker.postMessage.bind(worker)
        vi.spyOn(worker, 'postMessage').mockImplementation((reply, transfer) => {
          if (reply.type === 'credit') {
            outstanding--
            allCreditsAfterYield &&= yieldedIndex === reply.index
          }
          post(reply, transfer)
        })
        worker.on('message', (message: LegacyImportWorkerMessage) => {
          if (message.type === 'items') {
            batches.push(message)
            maximumOutstanding = Math.max(maximumOutstanding, ++outstanding)
            setImmediate(() => {
              yieldedIndex = message.index
            })
          }
        })
        return worker
      }
    )
    if (!prepared.ok) {
      throw new Error(prepared.error)
    }
    expect(
      prepared.items.map((item) => item.identity.provider === 'claude' && item.identity.uuid)
    ).toEqual([...Array.from({ length: count }, (_, index) => `row-${index}`), 'large'])
    expect(batches.reduce((total, batch) => total + batch.items.length, 0)).toBe(count + 1)
    expect(
      batches.every(
        (batch) => Buffer.byteLength(JSON.stringify(batch)) <= 65536 || batch.items.length === 1
      )
    ).toBe(true)
    expect(batches.some((batch) => Buffer.byteLength(JSON.stringify(batch)) > 65536)).toBe(true)
    expect(maximumOutstanding).toBe(1)
    expect(outstanding).toBe(0)
    expect(allCreditsAfterYield).toBe(true)
  }
)

it('preserves scalar values and own properties through the real transfer', async () => {
  const filePath = join(root, 'scalar.jsonl')
  await writeFile(
    filePath,
    '{"type":"assistant","uuid":"scalar","message":{"content":[{"type":"tool_use","id":"scalar-call","name":"test","input":{"rows":[1e400,-0],"__proto__":{"kept":true}}}]}}\n'
  )
  const prepared = await runLegacyTranscriptImportWorker(
    request(filePath),
    async () => {},
    undefined,
    createLegacyImportTestWorker
  )
  if (!prepared.ok) {
    throw new Error(prepared.error)
  }
  const item = prepared.items[0]
  expect(Object.hasOwn(item, 'observedAt')).toBe(true)
  expect(item.observedAt).toBeUndefined()
  if (item.body.kind !== 'tool-call') {
    throw new Error('Expected a tool input')
  }
  const input = item.body.input as { rows: number[]; __proto__: { kept: boolean } }
  expect(input.rows[0]).toBe(Infinity)
  expect(Object.is(input.rows[1], -0)).toBe(true)
  expect(Object.hasOwn(input, '__proto__')).toBe(true)
  expect(input.__proto__).toEqual({ kept: true })
  expect(Object.getPrototypeOf(input)).toBe(Object.prototype)
})
