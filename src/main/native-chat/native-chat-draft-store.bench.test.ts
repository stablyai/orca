import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNativeChatDraftStore, type NativeChatDraftStore } from './native-chat-draft-store'

// How long a draft write takes in the main process (the IPC hop is not here): the save after a
// send, and the bounded wait a queued message's take-back does before deleting the host's copy.
const ITERATIONS = 1000
const BUDGET_P50_MS = 2
const BUDGET_P99_MS = 20
const describeBench = process.env.ORCA_NATIVE_CHAT_DRAFT_BENCH === '1' ? describe : describe.skip

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * fraction) - 1]!
}

const typed = (index: number) => ({
  text: `a message being typed ${index} `.repeat(8),
  attachments: []
})

async function timeClears(
  store: NativeChatDraftStore,
  before: (scopeKey: string, index: number) => Promise<unknown>
): Promise<{ p50: number; p99: number }> {
  const samples: number[] = []
  for (let index = 0; index < ITERATIONS; index += 1) {
    const scopeKey = `session:bench-${index % 16}`
    await before(scopeKey, index)
    const startedAt = performance.now()
    await store.write(scopeKey, null)
    samples.push(performance.now() - startedAt)
  }
  return { p50: percentile(samples, 0.5), p99: percentile(samples, 0.99) }
}

describeBench('native chat draft store latency', () => {
  let root = ''
  let store: NativeChatDraftStore

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-native-chat-draft-bench-'))
    store = createNativeChatDraftStore(join(root, 'drafts'))
    await store.load()
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.each([
    ['clear alone', async () => {}],
    [
      'clear after a typing write',
      (scopeKey: string, index: number) => store.write(scopeKey, typed(index))
    ],
    [
      'clear with a typing write in flight',
      async (scopeKey: string, index: number) => void store.write(scopeKey, typed(index))
    ]
  ] as const)('%s', async (name, before) => {
    const { p50, p99 } = await timeClears(store, before)
    console.log(
      `[native-chat-draft-bench] ${name}: p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms`
    )
    expect(p50).toBeLessThanOrEqual(BUDGET_P50_MS)
    expect(p99).toBeLessThanOrEqual(BUDGET_P99_MS)
  })

  it('put-back rewrite', async () => {
    const samples: number[] = []
    for (let index = 0; index < ITERATIONS; index += 1) {
      const startedAt = performance.now()
      await store.write(`session:bench-${index % 16}`, typed(index))
      samples.push(performance.now() - startedAt)
    }
    const p50 = percentile(samples, 0.5)
    const p99 = percentile(samples, 0.99)
    console.log(
      `[native-chat-draft-bench] put-back rewrite: p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms`
    )
    expect(p50).toBeLessThanOrEqual(BUDGET_P50_MS)
    expect(p99).toBeLessThanOrEqual(BUDGET_P99_MS)
  })
})
