import assert from 'node:assert/strict'
import test from 'node:test'
import { createRelayLoadReaderEvidence } from './relay-load-reader-evidence.mjs'

test('requires a queue increase above the pre-injection baseline for every origin', async () => {
  const samples = new Map([
    ['https://a.test', [7, 7, 11]],
    ['https://b.test', [0, 3]]
  ])
  let now = 0
  const evidence = await createRelayLoadReaderEvidence([...samples.keys()], {
    readQueuedBytes: async (origin) => samples.get(origin).shift(),
    delay: async (ms) => { now += ms },
    now: () => now
  })

  await Promise.all([
    evidence.observe({ cellOrigin: 'https://a.test' }),
    evidence.observe({ cellOrigin: 'https://b.test' })
  ])

  assert.deepEqual(evidence.snapshot(), [
    { origin: 'https://a.test', baselineBytes: 7, peakBytes: 11, increaseBytes: 4 },
    { origin: 'https://b.test', baselineBytes: 0, peakBytes: 3, increaseBytes: 3 }
  ])
})

test('shares one causal proof across concurrent readers on the same cell', async () => {
  const samples = [4, 4, 9]
  let reads = 0
  let now = 0
  const evidence = await createRelayLoadReaderEvidence(['https://cell.test'], {
    readQueuedBytes: async () => { reads++; return samples.shift() },
    delay: async (ms) => { now += ms },
    now: () => now
  })

  await Promise.all([
    evidence.observe({ cellOrigin: 'https://cell.test' }),
    evidence.observe({ cellOrigin: 'https://cell.test' })
  ])

  assert.equal(reads, 3)
  assert.equal(evidence.snapshot()[0].increaseBytes, 5)
})

test('reuses a completed causal proof for later readers on the same cell', async () => {
  const samples = [4, 9]
  let reads = 0
  const evidence = await createRelayLoadReaderEvidence(['https://cell.test'], {
    readQueuedBytes: async () => { reads++; return samples.shift() },
    delay: async () => undefined
  })

  await evidence.observe({ cellOrigin: 'https://cell.test' })
  await evidence.observe({ cellOrigin: 'https://cell.test' })

  assert.equal(reads, 2)
  assert.equal(evidence.snapshot()[0].increaseBytes, 5)
})

test('rejects a pre-existing nonzero queue that never increases', async () => {
  let now = 0
  const evidence = await createRelayLoadReaderEvidence(['https://cell.test'], {
    readQueuedBytes: async () => 9,
    delay: async (ms) => { now += ms },
    now: () => now,
    timeoutMs: 200,
    pollMs: 100
  })

  await assert.rejects(
    evidence.observe({ cellOrigin: 'https://cell.test' }),
    /no causal Relay queued-byte increase/
  )
})
