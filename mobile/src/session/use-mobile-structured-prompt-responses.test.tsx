import { createElement, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import {
  encodeAgentSessionQuestionAnswers,
  type AgentSessionQuestionAnswer
} from '../../../src/shared/agent-session-question-answer'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  type StructuredAgentSessionState
} from '../../../src/shared/structured-agent-session-reducer'
import { formatQuestionFreeTextAnswer } from './native-chat/input/mobile-native-chat-question'
import {
  projectStructuredQuestion,
  type StructuredQuestionItem
} from './mobile-structured-agent-prompts'
import type { StructuredAgentSessionMutate } from './mobile-structured-agent-session-rpc'
import { useMobileStructuredPromptResponses } from './use-mobile-structured-prompt-responses'

type PromptResponses = ReturnType<typeof useMobileStructuredPromptResponses>

let currentHook: PromptResponses | null = null
let renderer: ReactTestRenderer | null = null

function groupedPrompt(itemId: string, revision: number): StructuredQuestionItem {
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

function Probe(props: {
  state: StructuredAgentSessionState
  mutate: StructuredAgentSessionMutate
  questionAnswersSupported?: boolean | null
  onSendError?: (message: string) => void
}) {
  const stateRef = useRef(props.state)
  stateRef.current = props.state
  currentHook = useMobileStructuredPromptResponses({
    stateRef,
    mutate: props.mutate,
    questionAnswersSupported: props.questionAnswersSupported ?? null,
    onSendError: props.onSendError ?? vi.fn()
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
  describe('answer wire', () => {
    const LONG_ANSWER = 'Proceed with the replacement, but wait for the capture. '.repeat(30).trim()

    function singlePrompt(): StructuredQuestionItem {
      return {
        itemId: 'item-s',
        revision: 3,
        sequence: 1,
        observedAt: 1,
        body: {
          kind: 'question',
          question: 'Anything else?',
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' }
          ],
          freeTextQuestionId: 'notes',
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }
      }
    }

    function recordingMutate() {
      const sent: { method: string; fields: Record<string, unknown> }[] = []
      const mutate: StructuredAgentSessionMutate = async (method, _fingerprint, fields) => {
        sent.push({ method, fields })
        return { status: 'rejected' }
      }
      return { mutate, sent }
    }

    function mount(
      prompt: AgentJournalRenderItem,
      mutate: StructuredAgentSessionMutate,
      questionAnswersSupported: boolean | null,
      onSendError?: (message: string) => void
    ): void {
      act(() => {
        renderer = create(
          createElement(Probe, {
            state: sessionState(prompt),
            mutate,
            questionAnswersSupported,
            onSendError
          })
        )
      })
    }

    function sentFields(sent: ReturnType<typeof recordingMutate>['sent']): Record<string, unknown> {
      expect(sent).toHaveLength(1)
      expect(sent[0]!.method).toBe('agentSession.respondToQuestion')
      return sent[0]!.fields
    }

    it('sends a long typed answer as structured answers to a capable host', async () => {
      const prompt = singlePrompt()
      const { mutate, sent } = recordingMutate()
      mount(prompt, mutate, true)
      const card = projectStructuredQuestion(prompt)!

      await act(async () => {
        await hook().respondQuestion(formatQuestionFreeTextAnswer(card, LONG_ANSWER))
      })

      expect(sentFields(sent)).toEqual({
        itemId: 'item-s',
        expectedRevision: 3,
        answers: [{ questionId: 'notes', optionIds: [], other: LONG_ANSWER }]
      })
    })

    it('packs a typed answer into the option id for a host that predates answers', async () => {
      const prompt = singlePrompt()
      const { mutate, sent } = recordingMutate()
      mount(prompt, mutate, null)
      const card = projectStructuredQuestion(prompt)!

      await act(async () => {
        await hook().respondQuestion(formatQuestionFreeTextAnswer(card, '  DuckDB  '))
      })

      expect(sentFields(sent)).toEqual({
        itemId: 'item-s',
        expectedRevision: 3,
        optionId: 'notes:DuckDB'
      })
    })

    it('packs an allowed empty answer for a host that predates answers', async () => {
      const base = singlePrompt()
      const prompt: StructuredQuestionItem = {
        ...base,
        body: { ...base.body, freeTextInput: { allowEmpty: true } }
      }
      const { mutate, sent } = recordingMutate()
      mount(prompt, mutate, false)

      await act(async () => {
        await hook().respondQuestion(
          formatQuestionFreeTextAnswer(projectStructuredQuestion(prompt)!, '')
        )
      })

      expect(sentFields(sent)).toEqual({
        itemId: 'item-s',
        expectedRevision: 3,
        optionId: 'notes:'
      })
    })

    it('tries structured answers for an answer too long to pack while support is unknown', async () => {
      const prompt = singlePrompt()
      const { mutate, sent } = recordingMutate()
      mount(prompt, mutate, null)

      await act(async () => {
        await hook().respondQuestion(
          formatQuestionFreeTextAnswer(projectStructuredQuestion(prompt)!, LONG_ANSWER)
        )
      })

      expect(sentFields(sent)).toEqual({
        itemId: 'item-s',
        expectedRevision: 3,
        answers: [{ questionId: 'notes', optionIds: [], other: LONG_ANSWER }]
      })
    })

    it('tells the user to update an older host instead of sending an answer it must refuse', async () => {
      const prompt = singlePrompt()
      const { mutate, sent } = recordingMutate()
      const onSendError = vi.fn()
      mount(prompt, mutate, false, onSendError)

      let accepted = true
      await act(async () => {
        accepted = await hook().respondQuestion(
          formatQuestionFreeTextAnswer(projectStructuredQuestion(prompt)!, LONG_ANSWER)
        )
      })

      expect(accepted).toBe(false)
      expect(sent).toEqual([])
      expect(onSendError).toHaveBeenCalledWith(
        'Update Orca on your computer to send answers this long'
      )
    })

    it.each([
      [true, { answers: [{ questionId: 'notes', optionIds: ['no'] }] }],
      [false, { optionId: 'no' }]
    ])(
      'answers an option tap for the question it was shown on (answers: %s)',
      async (supported, wire) => {
        const prompt = singlePrompt()
        const { mutate, sent } = recordingMutate()
        mount(prompt, mutate, supported)

        await act(async () => {
          await hook().respondQuestion(projectStructuredQuestion(prompt)!.optionTokens[1]!)
        })

        expect(sentFields(sent)).toEqual({ itemId: 'item-s', expectedRevision: 3, ...wire })
      }
    )

    const RENDERED_GROUP = { itemId: 'item-g', expectedRevision: 1 }

    it('refuses grouped answers picked on a prompt that has since been replaced', async () => {
      const { mutate, sent } = recordingMutate()
      mount(groupedPrompt('item-g', 2), mutate, true)

      const answered = await hook().respondQuestion(
        encodeAgentSessionQuestionAnswers([
          { questionId: 'q1', optionIds: ['q1:choice-1'] },
          { questionId: 'q2', optionIds: ['q2:choice-1'] }
        ]),
        RENDERED_GROUP
      )

      expect(answered).toBe(false)
      expect(sent).toEqual([])
    })

    it.each([true, false])('submits a grouped question once (answers: %s)', async (supported) => {
      const prompt = groupedPrompt('item-g', 1)
      const { mutate, sent } = recordingMutate()
      mount(prompt, mutate, supported)

      const answers = [
        { questionId: 'q1', optionIds: ['q1:choice-1'] },
        { questionId: 'q2', optionIds: ['q2:choice-1'] }
      ]
      await act(async () => {
        await hook().respondQuestion(encodeAgentSessionQuestionAnswers(answers), RENDERED_GROUP)
      })

      expect(sentFields(sent)).toEqual({
        itemId: 'item-g',
        expectedRevision: 1,
        ...(supported
          ? { answers }
          : {
              optionId:
                'question-group:[{"questionId":"q1","optionIds":["q1:choice-1"]},{"questionId":"q2","optionIds":["q2:choice-1"]}]'
            })
      })
    })

    // Claude always uses grouped questions, including for a single long typed answer.
    it.each([
      [true, true],
      [null, true],
      [false, false]
    ])('submits a grouped long typed answer (answers: %s)', async (supported, expectSent) => {
      const base = groupedPrompt('item-g', 1)
      if (base.body.kind !== 'question' || !base.body.questions) {
        throw new Error('expected a grouped question')
      }
      const [first, second] = base.body.questions
      const prompt: StructuredQuestionItem = {
        ...base,
        body: { ...base.body, questions: [first!, { ...second!, freeTextQuestionId: 'q2' }] }
      }
      const { mutate, sent } = recordingMutate()
      const onSendError = vi.fn()
      mount(prompt, mutate, supported, onSendError)

      const answers: AgentSessionQuestionAnswer[] = [
        { questionId: 'q1', optionIds: ['q1:choice-1'] },
        { questionId: 'q2', optionIds: [], other: LONG_ANSWER }
      ]
      await act(async () => {
        await hook().respondQuestion(encodeAgentSessionQuestionAnswers(answers), RENDERED_GROUP)
      })

      if (!expectSent) {
        expect(sent).toEqual([])
        expect(onSendError).toHaveBeenCalledWith(
          'Update Orca on your computer to send answers this long'
        )
        return
      }
      expect(sentFields(sent)).toEqual({ itemId: 'item-g', expectedRevision: 1, answers })
    })

    it('names the single question an option tap answers when the prompt has no typed field', async () => {
      const base = singlePrompt()
      const { freeTextQuestionId: _omitted, ...body } = base.body
      const prompt: StructuredQuestionItem = { ...base, body }
      const { mutate, sent } = recordingMutate()
      mount(prompt, mutate, true)

      await act(async () => {
        await hook().respondQuestion(projectStructuredQuestion(prompt)!.optionTokens[0]!)
      })

      expect(sentFields(sent)).toEqual({
        itemId: 'item-s',
        expectedRevision: 3,
        answers: [{ questionId: 'q1', optionIds: ['yes'] }]
      })
    })
  })
})
