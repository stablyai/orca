import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import { ClaudeSubagentIdentities } from '../../subagents/claude-subagent-identities'
import { claudeStreamingMessageBody } from './claude-structured-item-translation'

afterEach(() => vi.useRealTimers())

const textOf = (item: AgentJournalRenderItem): string =>
  item.body.kind === 'message' && item.body.blocks[0]?.type === 'text'
    ? item.body.blocks[0].text
    : ''

it('shows a long reply’s paused tail every window but saves it only once the stream goes quiet', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let read: (epoch: string) => readonly AgentJournalRenderItem[] = () => []
  const shown: string[] = []
  const saved: string[] = []
  const checkpoints = createClaudeStreamedTextCheckpoints({
    producer: new ClaudeSubagentIdentities({}).linkage,
    sink: {
      bindLiveText: (source) => {
        read = source.read
        return () => {}
      },
      publishLiveText: () => {
        shown.push(...read('epoch').map(textOf))
        return { accepted: true }
      }
    },
    liveBody: claudeStreamingMessageBody,
    persist: (_identity, text, _options, _ended, onCommitted) => {
      saved.push(text)
      onCommitted?.(
        {
          itemId: 'reply',
          revision: saved.length,
          sequence: 7,
          observedAt: 1,
          body: claudeStreamingMessageBody(text)
        },
        'epoch'
      )
    }
  })
  const identity = { provider: 'orca' as const, clientMessageId: 'reply' }
  const prefix = 'a'.repeat(20000)
  checkpoints.append(identity, prefix)
  vi.advanceTimersByTime(60)
  expect(saved).toEqual([prefix])
  checkpoints.append(identity, ' paused tail')
  vi.advanceTimersByTime(60)
  expect(shown).toEqual([`${prefix} paused tail`])
  expect(saved).toEqual([prefix])
  vi.advanceTimersByTime(939)
  expect(saved).toEqual([prefix])
  vi.advanceTimersByTime(1)
  expect(saved).toEqual([prefix, `${prefix} paused tail`])
  checkpoints.append(identity, ' final tail')
  checkpoints.finish({ completedAt: 2000 })
  expect(saved.at(-1)).toBe(`${prefix} paused tail final tail`)
  checkpoints.dispose()
})

it('spaces a trickling reply’s quiet saves further apart instead of saving at every pause', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const saved: string[] = []
  const checkpoints = createClaudeStreamedTextCheckpoints({
    producer: new ClaudeSubagentIdentities({}).linkage,
    sink: { bindLiveText: () => () => {}, publishLiveText: () => ({ accepted: true }) },
    liveBody: claudeStreamingMessageBody,
    persist: (_identity, text) => {
      saved.push(text)
    }
  })
  const identity = { provider: 'orca' as const, clientMessageId: 'reply' }
  checkpoints.append(identity, 'a'.repeat(20000))
  vi.advanceTimersByTime(60)
  // 100 short additions, each followed by just over a second of quiet.
  for (let pause = 0; pause < 100; pause++) {
    checkpoints.append(identity, ' word')
    vi.advanceTimersByTime(1100)
  }
  expect(saved.length).toBeLessThan(15)
  checkpoints.dispose()
})
