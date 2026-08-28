import { describe, expect, it } from 'vitest'
import type { AgentStatusFactInput } from '../../shared/agent-status-fact-types'
import { AgentStatusFactJournal } from './agent-status-fact-journal'

const fact = (paneKey: string): AgentStatusFactInput => ({
  paneKey,
  worktreeId: 'repo::/worktree',
  status: null
})

describe('AgentStatusFactJournal', () => {
  it('assigns ordered facts and replays after a cursor', () => {
    const journal = new AgentStatusFactJournal(8)
    const first = journal.record(fact('pane-1'))
    const second = journal.record(fact('pane-2'))

    expect(journal.readSince(first.seq, first.epoch).facts).toEqual([second])
    expect(journal.readSince(second.seq, second.epoch).facts).toEqual([])
  })

  it('seeds a cold subscriber silently', () => {
    const journal = new AgentStatusFactJournal(8)
    journal.record(fact('pane-1'))
    const read = journal.readSince()

    expect(read.gap).toBe(false)
    expect(read.facts).toEqual([])
    expect(read.headSeq).toBe(1)
  })

  it('reports an epoch or retention gap without returning history', () => {
    const journal = new AgentStatusFactJournal(2)
    const first = journal.record(fact('pane-1'))
    journal.record(fact('pane-2'))
    journal.record(fact('pane-3'))

    expect(journal.readSince(0, first.epoch).gap).toBe(true)
    expect(journal.readSince(0, 'old-epoch')).toMatchObject({ gap: true, facts: [] })
  })

  it('fans out live facts exactly once per subscription', () => {
    const journal = new AgentStatusFactJournal()
    const received: number[] = []
    const unsubscribe = journal.subscribe((entry) => received.push(entry.seq))

    journal.record(fact('pane-1'))
    unsubscribe()
    journal.record(fact('pane-2'))

    expect(received).toEqual([1])
  })

  it('isolates a throwing listener from later live subscribers', () => {
    const journal = new AgentStatusFactJournal()
    const received: string[] = []
    journal.subscribe(() => {
      throw new Error('stale stream')
    })
    journal.subscribe((entry) => received.push(entry.paneKey))

    journal.record(fact('pane-1'))

    expect(received).toEqual(['pane-1'])
  })
})
