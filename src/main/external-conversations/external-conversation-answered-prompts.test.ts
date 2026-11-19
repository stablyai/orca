import { describe, expect, it, vi } from 'vitest'
import type { PendingPrompt } from '../../shared/agent-status/contracts/agent-pending-prompt'
import { AnsweredPrompts } from './external-conversation-answered-prompts'
import type { ConversationPane } from './external-conversation-types'

const pane: ConversationPane = {
  conversation: { source: 'slack', externalId: 'T1:C9:1' },
  worktreeId: 'wt',
  paneKey: 'p'
}
const prompt: PendingPrompt = { kind: 'unsupported', promptId: 'q1' }

function answered(working: () => boolean) {
  const emit = vi.fn()
  return { prompts: new AnsweredPrompts({ working, emit }), emit }
}

describe('AnsweredPrompts', () => {
  it('follows a prompt a snapshot shows, so one pending when the watch began is told answered', () => {
    let working = false
    const { prompts, emit } = answered(() => working)
    prompts.saw({
      kind: 'snapshot',
      conversations: [{ ...pane, agent: 'claude', working, prompt, turnId: 1, activeAt: 1 }]
    })
    prompts.settle('p')
    expect(emit).not.toHaveBeenCalled()

    working = true
    prompts.settle('p')
    prompts.settle('p')
    expect(emit.mock.calls).toEqual([[{ kind: 'prompt', ...pane, prompt, answered: true }]])
  })

  it('keeps a newer prompt followed through an older turn’s late end', () => {
    const { prompts, emit } = answered(() => true)
    prompts.saw({ kind: 'prompt', ...pane, prompt })
    prompts.saw({ kind: 'turn-ended', ...pane, turnId: 1, stopReason: null, at: 2 })
    prompts.settle('p')
    expect(emit).toHaveBeenCalledOnce()
  })

  it('never tells a connector’s own answer as answered in Orca, unless it didn’t land', () => {
    const { prompts, emit } = answered(() => true)
    prompts.saw({ kind: 'prompt', ...pane, prompt })
    prompts.answering('p', 'q1')
    prompts.settle('p')
    expect(emit).not.toHaveBeenCalled()

    prompts.saw({ kind: 'prompt', ...pane, prompt })
    const keep = prompts.answering('p', 'q1')
    keep()
    prompts.settle('p')
    expect(emit).toHaveBeenCalledOnce()
  })

  it('leaves a different prompt shown when the answer names another', () => {
    const { prompts, emit } = answered(() => true)
    prompts.saw({ kind: 'prompt', ...pane, prompt })
    prompts.answering('p', 'q-old')
    prompts.settle('p')
    expect(emit).toHaveBeenCalledOnce()
  })
})

it('includes chosen option labels when Orca answers, and keeps typed answers private', async () => {
  const emit = vi.fn()
  let typed = false
  const prompts = new AnsweredPrompts({
    working: () => true,
    emit,
    resolvedPrompt: () => ({
      itemId: 'q1',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'question',
        question: 'Layout?',
        options: [],
        questions: [
          {
            id: 'layout',
            question: 'Layout?',
            multiSelect: false,
            options: [{ id: 'compact', label: 'Compact' }]
          }
        ],
        resolution: {
          state: 'resolved',
          selectedOptionId: null,
          resolvedAt: 2,
          resolvedBy: 'desktop',
          answers: typed
            ? [{ questionId: 'layout', optionIds: [], other: 'Private typed answer' }]
            : [{ questionId: 'layout', optionIds: ['compact'] }]
        }
      }
    })
  })
  const shown = {
    kind: 'prompt' as const,
    ...pane,
    prompt: { ...prompt, open: { sessionId: 'session-1', itemId: 'q1' } }
  }
  prompts.saw(shown)
  prompts.settle('p')
  await vi.waitFor(() =>
    expect(emit.mock.calls[0]?.[0]).toMatchObject({ answered: true, answeredWith: 'Compact' })
  )
  typed = true
  prompts.saw(shown)
  prompts.settle('p')
  await vi.waitFor(() => expect(emit.mock.calls[1]?.[0]).toMatchObject({ answered: true }))
  expect(emit.mock.calls[1]?.[0]).not.toHaveProperty('answeredWith')
})
