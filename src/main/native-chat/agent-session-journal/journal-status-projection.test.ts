import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionStatusSummary } from '../../../shared/structured-agent-session-projection'
import { JournalStatusProjection } from './journal-status-projection'

type Item = AgentJournalRenderItem
const message = (text: string, role: 'user' | 'assistant' = 'assistant'): Item['body'] => ({
  kind: 'message',
  role,
  blocks: [{ type: 'text', text }]
})

function setup() {
  const items = new Map<string, Item>()
  const projection = new JournalStatusProjection()
  const set = (id: string, sequence: number, body: Item['body']) => {
    const item = { itemId: id, sequence, revision: 1, observedAt: sequence, body }
    items.set(id, item)
    projection.changed(item, id)
  }
  const check = () =>
    expect(projection.read(items)).toEqual(
      projectStructuredAgentSessionStatusSummary(
        [...items.values()].sort((a, b) => a.sequence - b.sequence)
      )
    )
  return { items, projection, set, check }
}

describe('journal status projection', () => {
  it('matches full replay through revisions, tombstones, ties, and late historical updates', () => {
    const { items, projection, set, check } = setup()
    const bodies: Item['body'][] = [
      message('prompt', 'user'),
      message('reply'),
      message(''),
      {
        kind: 'approval',
        title: 'Allow?',
        detail: null,
        options: [],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      {
        kind: 'question',
        question: 'Which?',
        options: [],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { kind: 'status', text: '', turnLifecycle: { state: 'running', turnId: 'turn' } },
      { kind: 'status', text: '', turnLifecycle: { state: 'completed', turnId: 'turn' } },
      { kind: 'tool-call', name: 'Read', input: { path: '/file' }, state: 'running' },
      { kind: 'tool-call', name: 'Read', input: { path: '/file' }, state: 'completed' }
    ]
    let seed = 42
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    for (let i = 0; i < 3000; i++) {
      const id = String(random() % 50)
      if (random() % 5 === 0) {
        items.delete(id)
        projection.changed(undefined, id)
      } else {
        set(id, items.get(id)?.sequence ?? random() % 100, bodies[random() % bodies.length])
      }
      check()
    }
  })

  it('does not traverse retained history during streaming revisions or repeated reads', () => {
    const { items, projection, set, check } = setup()
    for (let index = 0; index < 10_000; index++) {
      set(String(index), index, message('historical'))
    }
    set('prompt', 10_000, message('current', 'user'))
    set('reply', 10_001, message('current reply'))
    check()
    const values = vi.spyOn(items, 'values')
    for (let index = 0; index < 1000; index++) {
      set('reply', 10_001, message(`reply ${index}`))
      expect(projection.read(items).lastAssistantMessage).toBe(`reply ${index}`)
      projection.read(items)
    }
    expect(values).not.toHaveBeenCalled()
  })
})
