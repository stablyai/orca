import { afterEach, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault/contracts/ai-vault-types'
import { SessionRowPublisher } from './session-row-publisher'

afterEach(() => vi.useRealTimers())

function row(id: string, title = id): AiVaultSession {
  return {
    id,
    sessionId: id,
    title,
    executionHostId: 'local',
    agent: 'codex',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/sessions/${id}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-11-13',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'codex',
    subagent: null
  }
}

it.each([100, 1000])(
  'sends each changed row once in bounded frames at N=%i, with one flight',
  async (count) => {
    vi.useFakeTimers()
    const delivered = new Map<string, AiVaultSession>()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const frames: number[] = []
    let flights = 0
    let maximum = 0
    const publisher = new SessionRowPublisher(async (delta) => {
      maximum = Math.max(maximum, ++flights)
      frames.push(Buffer.byteLength(JSON.stringify(delta)))
      for (const entry of delta.upserts) {
        delivered.set(entry.id, entry)
      }
      await blocked
      flights--
    })
    publisher.observe({ upserts: [row('initial')], removed: [] })
    expect(frames).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(250)
    for (let index = 0; index < count; index++) {
      publisher.observe({ upserts: [row(String(index), 'superseded')], removed: [] })
      publisher.observe({ upserts: [row(String(index))], removed: [] })
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(frames).toHaveLength(1)
    release()
    await vi.advanceTimersByTimeAsync(250)
    expect(maximum).toBe(1)
    expect(delivered.size).toBe(count + 1)
    expect([...delivered.values()].every((entry) => entry.title === entry.id)).toBe(true)
    expect(frames.every((bytes) => bytes <= 128 * 1024 + 32)).toBe(true)
    publisher.observe({ upserts: [row('abandoned')], removed: [] })
    publisher.finish()
    await vi.advanceTimersByTimeAsync(1000)
    expect(delivered.has('abandoned')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  }
)
