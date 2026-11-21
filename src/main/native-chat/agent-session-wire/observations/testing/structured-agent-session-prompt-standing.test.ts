import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnLifecycleState
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  structuredAgentSessionPromptStanding,
  type PromptStandingEvidence,
  type StructuredAgentSessionPromptStanding
} from '../structured-agent-session-prompt-standing'
import type {
  StructuredAgentSessionReplacedEnd,
  StructuredAgentSessionSeenEnd
} from '../structured-agent-session-work-evidence'

const PROMPT = 'prompt-p'
const TURN = 'turn-a'
const F = 4

type Journal = Parameters<typeof structuredAgentSessionPromptStanding>[0]

type Case = {
  turn: AgentJournalTurnLifecycleState
  /** null: owner unverifiable; a number: the live fence. */
  owner: number | null
  ended?: StructuredAgentSessionSeenEnd
  replaced?: StructuredAgentSessionReplacedEnd
  releasedThrough?: number
  answered?: boolean
  /** The prompt's own generation; undefined when its provenance is unknown. */
  fence?: number
}

function journalFor(c: Pick<Case, 'turn' | 'answered' | 'fence'>): Journal {
  const prompt: AgentJournalRenderItem = {
    itemId: PROMPT,
    revision: 1,
    sequence: 2,
    observedAt: 2,
    turnScope: { kind: 'turn', turnItemId: TURN },
    body: {
      kind: 'question',
      question: 'Merge?',
      options: [{ id: 'yes', label: 'Yes' }],
      resolution: c.answered
        ? { state: 'resolved', selectedOptionId: 'yes', resolvedBy: 'desktop', resolvedAt: 3 }
        : { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
  const items = new Map<string, AgentJournalRenderItem>([[PROMPT, prompt]])
  items.set(TURN, {
    itemId: TURN,
    revision: 1,
    sequence: 1,
    observedAt: 1,
    turnScope: { kind: 'thread' },
    body: { kind: 'turn', turnId: 'a', state: c.turn }
  })
  return {
    item: (id) => items.get(id) ?? null,
    itemFence: (id) => (id === PROMPT ? c.fence : F),
    hasRecordedItem: (id) => items.has(id)
  }
}

function standingOf(c: Case): StructuredAgentSessionPromptStanding {
  const evidence: PromptStandingEvidence = {
    liveFence: c.owner,
    ownerUnverifiable: c.owner === null,
    ended: c.ended,
    replaced: c.replaced,
    releasedThroughFence: c.releasedThrough ?? null
  }
  return structuredAgentSessionPromptStanding(journalFor(c), PROMPT, evidence)
}

const rootGone = (fence: number): StructuredAgentSessionSeenEnd => ({ fence, rootGone: true })

describe('a shown prompt’s standing', () => {
  it.each<[number, Case, StructuredAgentSessionPromptStanding]>([
    [1, { turn: 'unverifiable', owner: null, ended: rootGone(F), fence: F }, 'gone'],
    [2, { turn: 'unverifiable', owner: null, fence: F }, 'unknown'],
    [3, { turn: 'unverifiable', owner: null, ended: rootGone(3), fence: F }, 'unknown'],
    [4, { turn: 'running', owner: null, replaced: { fence: F }, fence: F }, 'gone'],
    [5, { turn: 'running', owner: null, replaced: { fence: 3 }, fence: F }, 'unknown'],
    [6, { turn: 'running', owner: null, releasedThrough: F, fence: F }, 'gone'],
    [7, { turn: 'running', owner: null, fence: F }, 'unknown'],
    [9, { turn: 'unverifiable', owner: F, fence: F }, 'unknown'],
    [10, { turn: 'running', owner: F, fence: F }, 'pending'],
    [11, { turn: 'running', owner: 5, fence: F }, 'gone'],
    [12, { turn: 'completed', owner: null, fence: F }, 'gone'],
    [12, { turn: 'interrupted', owner: F, fence: F }, 'gone'],
    [13, { turn: 'running', owner: null, answered: true, fence: F }, 'gone'],
    [14, { turn: 'running', owner: null, ended: rootGone(F) }, 'unknown']
  ])('case %i', (_case, input, expected) => {
    expect(standingOf(input)).toBe(expected)
  })

  it('reads an observable owner with no live generation as over', () => {
    const journal = journalFor({ turn: 'running', fence: F })
    const evidence: PromptStandingEvidence = {
      liveFence: null,
      ownerUnverifiable: false,
      releasedThroughFence: null
    }
    expect(structuredAgentSessionPromptStanding(journal, PROMPT, evidence)).toBe('gone')
  })

  it('reads a rewound prompt as gone, and one the journal never had as unknown', () => {
    const live: PromptStandingEvidence = {
      liveFence: F,
      ownerUnverifiable: false,
      releasedThroughFence: null
    }
    const rewound: Journal = {
      item: () => null,
      itemFence: () => F,
      hasRecordedItem: () => true
    }
    expect(structuredAgentSessionPromptStanding(rewound, PROMPT, live)).toBe('gone')
    const journal = journalFor({ turn: 'running', fence: F })
    expect(structuredAgentSessionPromptStanding(journal, 'never-seen', live)).toBe('unknown')
  })
})
