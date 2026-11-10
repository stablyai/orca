import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { messageFixture, target } from '../agent-session-journal/journal-sql-message.test-fixture'
import { applyJournalDomainItem } from '../agent-session-journal/journal-domain-item'
import type { JournalStepsResult } from '../agent-session-journal/writing/journal-writer-step'
import type { ProviderTimelineSink } from './provider-timeline-plan'
import { createProviderTimelineAssembler } from './provider-timeline-assembler'

const close: (() => void)[] = []
afterEach(() => {
  close.splice(0).forEach((finish) => finish())
  vi.useRealTimers()
})

it('publishes live text while restart keeps the saved block, then saves a clean window and authoritative final', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1000)
  const { db } = messageFixture()
  close.push(() => db.close())
  let pending = Promise.resolve()
  let window: (() => void) | undefined
  let source: Parameters<NonNullable<ProviderTimelineSink['bindLiveText']>>[0] | undefined
  const delivered: AgentJournalRenderItem[][] = []
  const sink: ProviderTimelineSink = {
    written: async () => {
      await pending
      return { ok: true }
    },
    bindLiveText: (next) => {
      source = next
      return () => {
        source = undefined
      }
    },
    publishLiveText: () => {
      pending = pending.then(() => {
        delivered.push([...(source?.read('epoch') ?? [])])
      })
      return { accepted: true }
    },
    tryAppendTransition: (transition) => {
      pending = pending.then(() => {
        const result: JournalStepsResult = { outcomes: [], items: [] }
        db.exec('BEGIN')
        try {
          for (const step of transition.steps) {
            if (step.kind !== 'item' || step.resolution.kind !== 'text-snapshot') {
              throw new Error('this contract emits only text snapshots')
            }
            const committed = applyJournalDomainItem(
              db,
              target,
              {
                ...step.resolution,
                options: { ...step.options, fence: 1 }
              },
              Date.now()
            )
            result.outcomes.push(committed.outcome)
            result.items!.push(...committed.items)
            result.cursor = committed.cursor
          }
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
        transition.onResolved?.(result.outcomes, result)
        transition.onPublished?.()
      })
      return { accepted: true }
    }
  }
  const assembler = createProviderTimelineAssembler({
    sink,
    sessionId: 'chat',
    agent: 'codex',
    generation: 'one',
    namespace: 'provider',
    schedule: (run) => {
      window = run
      return () => {
        if (window === run) {
          window = undefined
        }
      }
    }
  })
  const drain = async () => {
    await pending
    await pending
  }
  const text = (item: AgentJournalRenderItem | undefined) =>
    item?.body.kind === 'message' && item.body.blocks[0]?.type === 'text'
      ? item.body.blocks[0].text
      : ''
  const saved = () =>
    text(
      JSON.parse(String(db.prepare('SELECT payload_json FROM journal_items').get()?.payload_json))
    )
  const delta = (text: string) =>
    assembler.apply({ type: 'text.delta', item: { id: 'message' }, channel: 'assistant', text })
  delta('Hello')
  await drain()
  expect(saved()).toBe('Hello')
  delta(' world')
  window?.()
  await drain()
  expect(text(delivered.at(-1)?.[0])).toBe('Hello world')
  expect(saved()).toBe('Hello')
  // A barrier still owes the live value after the coalescer's dirty bit cleared.
  assembler.flush()
  await drain()
  expect(saved()).toBe('Hello world')
  vi.setSystemTime(2000)
  delta('\n\nNext unfinished')
  window?.()
  await drain()
  expect(saved()).toBe('Hello world\n\n')
  expect(text(delivered.at(-1)?.[0])).toBe('Hello world\n\nNext unfinished')
  assembler.apply({ type: 'text.close', item: { id: 'message' }, text: 'Replacement' })
  expect(delta(' late').dropped).toBe('item-settled')
  assembler.flush()
  await drain()
  expect(saved()).toBe('Replacement')
  expect(source?.read('epoch')).toEqual([])
  assembler.dispose()
  await drain()
})
