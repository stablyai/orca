import { expect, it } from 'vitest'
import { readStreamedSessionDocument } from './session-document-stream'

function collectHeap(): number {
  if (!globalThis.gc) {
    throw new Error('Run this regression with --expose-gc')
  }
  void /reset/.test('reset')
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

it.each(['string', 'number'])('does not assemble a large ignored %s', async (kind) => {
  const baseline = collectHeap()
  let retainedBytes = 0
  async function* bytes() {
    yield Buffer.from(
      kind === 'string' ? '{"ignored":{"attachment":"' : '{"ignored":{"attachment":1'
    )
    for (let i = 0; i < 128; i++) {
      yield Buffer.from((kind === 'string' ? 'x' : '0').repeat(256 * 1024))
    }
    retainedBytes = collectHeap() - baseline
    yield Buffer.from(
      `${kind === 'string' ? '"' : ''}},"session_id":"kept","messages":[{"text":"last message"}]}`
    )
  }
  const result = await readStreamedSessionDocument({
    bytes: bytes(),
    arrayKey: 'messages',
    fields: ['session_id'],
    create: () => ({ count: 0 }),
    consume: (state) => state.count++
  })
  expect(result?.record).toEqual({ session_id: 'kept' })
  expect(result?.state.count).toBe(1)
  expect(retainedBytes).toBeLessThan(8 * 1024 * 1024)
})
