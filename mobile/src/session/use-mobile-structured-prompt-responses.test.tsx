import { createElement, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionPromptResult } from '../../../src/shared/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  type StructuredAgentSessionState
} from '../../../src/shared/structured-agent-session-reducer'
import { projectStructuredQuestion } from './mobile-structured-agent-prompts'
import type {
  StructuredAgentSessionMutate,
  StructuredAgentSessionMutationResult
} from './mobile-structured-agent-session-rpc'
import { groupedQuestionPromptKey } from './mobile-structured-grouped-question'
import { useMobileStructuredPromptResponses } from './use-mobile-structured-prompt-responses'

type PromptResponses = ReturnType<typeof useMobileStructuredPromptResponses>

let currentHook: PromptResponses | null = null
let renderer: ReactTestRenderer | null = null

function groupedPrompt(itemId: string, revision: number): AgentJournalRenderItem {
  return {
    itemId,
    revision,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'question',
      question: '2 grouped questions from Claude',
      options: [],
      questions: [
        {
          id: 'q1',
          question: 'First?',
          multiSelect: false,
          options: [
            { id: 'q1:choice-1', label: 'One' },
            { id: 'q1:choice-2', label: 'Another one' }
          ]
        },
        {
          id: 'q2',
          question: 'Second?',
          multiSelect: false,
          options: [
            { id: 'q2:choice-1', label: 'Two' },
            { id: 'q2:choice-2', label: 'Another two' }
          ]
        }
      ],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
}

function sessionState(prompt: AgentJournalRenderItem): StructuredAgentSessionState {
  return { ...EMPTY_STRUCTURED_AGENT_SESSION, status: 'ready', items: [prompt] }
}

function projectedResponse(prompt: AgentJournalRenderItem, draft: PromptResponses['groupedDraft']) {
  const projected = projectStructuredQuestion(prompt, draft)
  const response = projected?.optionTokens[0]
  if (!response) {
    throw new Error('Grouped question did not project an option response')
  }
  return response
}

function Probe(props: {
  sessionKey: string
  state: StructuredAgentSessionState
  mutate: StructuredAgentSessionMutate
}) {
  const stateRef = useRef(props.state)
  stateRef.current = props.state
  currentHook = useMobileStructuredPromptResponses({
    stateRef,
    sessionKey: props.sessionKey,
    mutate: props.mutate,
    onSendError: vi.fn()
  })
  return null
}

function hook(): PromptResponses {
  if (!currentHook) {
    throw new Error('Hook probe is not mounted')
  }
  return currentHook
}

afterEach(() => {
  act(() => renderer?.unmount())
  currentHook = null
  renderer = null
})

describe('useMobileStructuredPromptResponses', () => {
  it.each([
    ['another session', 'session-b', groupedPrompt('item-b', 1)],
    ['a newer prompt revision', 'session-a', groupedPrompt('item-a', 2)]
  ])(
    'does not let a completed grouped response clear %s draft',
    async (_, nextSession, nextPrompt) => {
      const firstPrompt = groupedPrompt('item-a', 1)
      let resolveMutation!: (
        value: StructuredAgentSessionMutationResult<AgentSessionPromptResult>
      ) => void
      const pendingMutation = new Promise<
        StructuredAgentSessionMutationResult<AgentSessionPromptResult>
      >((resolve) => {
        resolveMutation = resolve
      })
      const mutate = vi.fn(() => pendingMutation) as unknown as StructuredAgentSessionMutate

      act(() => {
        renderer = create(
          createElement(Probe, {
            sessionKey: 'session-a',
            state: sessionState(firstPrompt),
            mutate
          })
        )
      })
      await act(async () => {
        await hook().respondQuestion(projectedResponse(firstPrompt, null))
      })
      let firstSubmission!: Promise<boolean>
      act(() => {
        firstSubmission = hook().respondQuestion(
          projectedResponse(firstPrompt, hook().groupedDraft)
        )
      })

      act(() => {
        renderer?.update(
          createElement(Probe, {
            sessionKey: nextSession,
            state: sessionState(nextPrompt),
            mutate
          })
        )
      })
      await act(async () => {
        await hook().respondQuestion(projectedResponse(nextPrompt, null))
      })
      expect(hook().groupedDraft?.answers).toHaveLength(1)

      await act(async () => {
        resolveMutation({
          status: 'accepted',
          value: {
            itemId: firstPrompt.itemId,
            revision: firstPrompt.revision,
            resolution: {
              state: 'resolved',
              selectedOptionId: 'q2:choice-1',
              resolvedBy: 'mobile',
              resolvedAt: 2
            }
          },
          sameFence: true
        })
        await firstSubmission
      })

      expect(hook().groupedDraft?.promptKey).toBe(
        groupedQuestionPromptKey(nextPrompt.itemId, nextPrompt.revision)
      )
      expect(hook().groupedDraft?.answers).toHaveLength(1)
    }
  )
})
