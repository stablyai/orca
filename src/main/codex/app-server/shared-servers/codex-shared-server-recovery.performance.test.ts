import { describe, expect, it } from 'vitest'
import {
  CODEX_SHARED_RECOVERY_MAX_IDENTITIES,
  CodexSharedServerRecovery
} from './codex-shared-server-recovery'
import { CODEX_SHARED_SERVER_BACKLOG_BYTES } from './codex-shared-server-backlog'
import {
  CODEX_SHARED_REATTACH_READS,
  recoverCodexSharedServerThreads
} from './codex-shared-server-reattach'
import type { CodexSharedServerFrame } from './codex-shared-server-frames'

// Caps a reattached shared server holds for chats that haven't claimed their threads yet: without
// them, a kept server's unclaimed threads would grow without bound while no app reads them.

const delta = (threadId: string, seq: number, text: string): CodexSharedServerFrame => ({
  kind: 'notification',
  method: 'item/agentMessage/delta',
  params: { threadId, delta: text },
  seq,
  threadId
})

function recoveryWithRoom(room = CODEX_SHARED_SERVER_BACKLOG_BYTES) {
  return new CodexSharedServerRecovery(
    () => {},
    () => room
  )
}

describe('shared Codex server recovery bounds', () => {
  it('holds at most 4,096 thread identities however many descendants spawn', () => {
    const recovery = recoveryWithRoom()
    recovery.expect({ sessionId: 'chat', threadId: 'root', workload: 'w' })
    recovery.holdUnowned('stray')
    let parent = 'root'
    for (let child = 0; child < 20_000; child += 1) {
      const threadId = `child-${child}`
      // Half chain under the last child, half fan out from the root; both under held parents.
      recovery.join(threadId, child % 2 === 0 ? parent : 'root')
      recovery.join(`stray-${child}`, 'stray')
      parent = threadId
      expect(recovery.identities).toBeLessThanOrEqual(CODEX_SHARED_RECOVERY_MAX_IDENTITIES)
    }
    // A collapsed family's later descendants are no longer tracked; its root and cut stay.
    expect(recovery.holds('root')).toBe(true)
    expect(recovery.holds('stray')).toBe(true)
    expect(recovery.take('root')?.cut).toBe(true)
  })

  it('holds at most 32 MiB of replay across any number of threads', () => {
    const recovery = recoveryWithRoom()
    const text = 'x'.repeat(64 * 1024)
    for (let chat = 0; chat < 1_000; chat += 1) {
      recovery.expect({ sessionId: `chat-${chat}`, threadId: `thread-${chat}`, workload: 'w' })
    }
    for (let seq = 1; seq <= 4_000; seq += 1) {
      recovery.hold(`thread-${seq % 1_000}`, delta(`thread-${seq % 1_000}`, seq, text))
      expect(recovery.bytes).toBeLessThanOrEqual(CODEX_SHARED_SERVER_BACKLOG_BYTES)
    }
  })

  it('reads at most 4 threads at once at reattach, after one loaded listing', async () => {
    let inFlight = 0
    let most = 0
    let listings = 0
    const loaded = Array.from({ length: 200 }, (_, at) => `loaded-${at}`)
    const connection = {
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === 'thread/loaded/list') {
          listings += 1
          return { data: loaded, nextCursor: null }
        }
        inFlight += 1
        most = Math.max(most, inFlight)
        await new Promise((resolve) => setImmediate(resolve))
        inFlight -= 1
        const threadId = String(params?.threadId)
        const parent = threadId === 'loaded-0' ? 'root' : 'loaded-0'
        return {
          thread: {
            id: threadId,
            source: { subAgent: { thread_spawn: { parent_thread_id: parent } } }
          }
        }
      }
    }
    const recovery = recoveryWithRoom()
    await recoverCodexSharedServerThreads({
      connection,
      recovery,
      expected: [{ sessionId: 'chat', threadId: 'root', workload: 'w' }]
    })
    expect(listings).toBe(1)
    expect(most).toBeLessThanOrEqual(CODEX_SHARED_REATTACH_READS)
    expect(recovery.identities).toBe(201)
  })
})
