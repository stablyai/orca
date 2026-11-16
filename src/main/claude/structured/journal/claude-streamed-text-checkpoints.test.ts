import { afterEach, expect, it, vi } from 'vitest'
import { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import { ClaudeSubagentIdentities } from '../../subagents/claude-subagent-identities'

afterEach(() => vi.useRealTimers())

it('saves a long reply’s paused tail without another delta and flushes its final tail', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const saved: string[] = []
  const checkpoints = createClaudeStreamedTextCheckpoints({
    producer: new ClaudeSubagentIdentities({}).linkage,
    persist: (_identity, text) => {
      saved.push(text)
    }
  })
  const identity = { provider: 'orca' as const, clientMessageId: 'reply' }
  const prefix = 'a'.repeat(20000)
  checkpoints.append(identity, prefix)
  vi.advanceTimersByTime(60)
  expect(saved).toEqual([prefix])
  checkpoints.append(identity, ' paused tail')
  vi.advanceTimersByTime(399)
  expect(saved).toEqual([prefix])
  vi.advanceTimersByTime(1)
  expect(saved).toEqual([prefix, `${prefix} paused tail`])
  checkpoints.append(identity, ' final tail')
  checkpoints.finish({ completedAt: 1000 })
  expect(saved).toEqual([prefix, `${prefix} paused tail`, `${prefix} paused tail final tail`])
  checkpoints.dispose()
})
