import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MobileStructuredPromptCard,
  type MobileStructuredPromptItem
} from './MobileStructuredPromptCard'

vi.mock('./MobileNativeChatPermission', () => ({
  MobileNativeChatPermission: 'MobileNativeChatPermission'
}))
vi.mock('./MobileNativeChatQuestion', () => ({
  MobileNativeChatQuestion: 'MobileNativeChatQuestion'
}))
vi.mock('./MobileStructuredQuestionGroupCard', () => ({
  MobileStructuredQuestionGroupCard: 'MobileStructuredQuestionGroupCard'
}))

const resolution = {
  state: 'pending' as const,
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
}

function prompt(body: MobileStructuredPromptItem['body']): MobileStructuredPromptItem {
  return { itemId: 'claude:session-1:item-1', revision: 1, sequence: 1, observedAt: 1, body }
}

describe('MobileStructuredPromptCard', () => {
  let renderer: ReactTestRenderer | null = null
  const onRespond = vi.fn().mockResolvedValue(true)

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    onRespond.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('preserves Claude permission response ids through the shared permission card', async () => {
    const item = prompt({
      kind: 'approval',
      title: 'Allow Bash?',
      detail: 'pnpm test',
      options: [
        { id: 'allow', label: 'Allow' },
        { id: 'allowForSession', label: 'Allow for session' },
        { id: 'deny', label: 'Deny' },
        { id: 'cancel', label: 'Cancel' }
      ],
      resolution
    })
    act(() => {
      renderer = create(createElement(MobileStructuredPromptCard, { item, onRespond }))
    })
    const card = renderer!.root.findByType('MobileNativeChatPermission')

    expect(card.props.permission).toEqual({
      title: 'Allow Bash?',
      detail: 'pnpm test',
      options: [
        { label: 'Allow', send: 'allow' },
        { label: 'Allow for session', send: 'allowForSession' },
        { label: 'Deny', send: 'deny' },
        { label: 'Cancel', send: 'cancel' }
      ]
    })
    await expect(card.props.onRespond('allowForSession')).resolves.toBe(true)
    expect(onRespond).toHaveBeenCalledWith(item, 'allowForSession')
  })

  it('maps Claude question choices and encodes free text through the shared question card', async () => {
    const item = prompt({
      kind: 'question',
      question: 'Choose a release channel',
      options: [
        { id: 'channel:stable', label: 'Stable' },
        { id: 'channel:beta', label: 'Beta' }
      ],
      freeTextQuestionId: 'release channel',
      resolution
    })
    act(() => {
      renderer = create(createElement(MobileStructuredPromptCard, { item, onRespond }))
    })
    const card = renderer!.root.findByType('MobileNativeChatQuestion')

    expect(card.props.question).toEqual({
      question: 'Choose a release channel',
      options: ['Stable', 'Beta'],
      multiSelect: false,
      optionTokens: [null, null]
    })
    expect(card.props.allowFreeText).toBe(true)
    await expect(card.props.onAnswer('Beta')).resolves.toBe(true)
    expect(onRespond).toHaveBeenLastCalledWith(item, 'channel:beta')
    await expect(card.props.onAnswer('Nightly / canary')).resolves.toBe(true)
    expect(onRespond).toHaveBeenLastCalledWith(item, 'release%20channel:Nightly%20%2F%20canary')
  })
})
