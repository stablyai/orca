import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { waitForRelayLoadPhaseBarrier } from './relay-load-phase-barrier.mjs'

const loadHarness = await readFile(new URL('./load-relay-controls.mjs', import.meta.url), 'utf8')

test('releases every shard only after all readiness markers exist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-load-barrier-'))
  try {
    let firstResolved = false
    const first = waitForRelayLoadPhaseBarrier({
      directory, shardCount: 2, shardIndex: 0, timeoutMs: 1_000
    }).then(() => { firstResolved = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(firstResolved, false)
    await Promise.all([
      first,
      waitForRelayLoadPhaseBarrier({
        directory, shardCount: 2, shardIndex: 1, timeoutMs: 1_000
      })
    ])
    assert.equal(firstResolved, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('fails closed on a duplicate shard or incomplete barrier', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-load-barrier-'))
  try {
    const nowValues = [0, 2]
    await assert.rejects(
      waitForRelayLoadPhaseBarrier(
        { directory, shardCount: 2, shardIndex: 0, timeoutMs: 1 },
        { now: () => nowValues.shift() ?? 2, delay: async () => undefined }
      ),
      /timed out/
    )
    await assert.rejects(
      waitForRelayLoadPhaseBarrier({
        directory, shardCount: 2, shardIndex: 0, timeoutMs: 1
      }),
      /EEXIST/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('synchronizes splice ramps after every shard finishes reader baselines', () => {
  assert.match(
    loadHarness,
    /createRelayLoadReaderEvidence[\s\S]*?phaseBarrierDir\}-splices[\s\S]*?splicePromises/
  )
})

test('budgets both shard barriers and the splice ramp in token lifetime', () => {
  assert.match(
    loadHarness,
    /phaseBarrierDir \? 2 \* config\.phaseBarrierTimeoutMs : 0[\s\S]*?config\.spliceRampMs/
  )
})
