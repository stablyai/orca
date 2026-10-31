import { activateMobileUiLocale, mobileI18n } from '../../../i18n/mobile-i18n'
import { MobileNativeChatSettledBodyContext } from '../../mobile-native-chat-settled-body'
import { createAgentSessionSettledBodyReader } from '../../../../../src/shared/agent-session-settled-body-reader'
import { agentSessionJsonPiece } from '../../../../../src/shared/agent-session-json-pieces'
import {
  AGENT_SESSION_SETTLED_BODY_CAPABILITY,
  type AgentSessionSettledBodyRead
} from '../../../../../src/shared/agent-session-settled-body'
import type { NativeChatResolvedPrompt } from '../../../../../src/shared/native-chat-resolution-receipt'
import { structuredQuestionTranscript } from '../../../../../src/shared/structured-agent-question-projection'
import type { AskPrompt } from '../../../../../src/shared/native-chat/input/native-chat-ask-types'
import { createElement, useLayoutEffect, useRef } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { Pressable, TextInput } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatAskDismiss } from './use-mobile-native-chat-ask-dismiss'
import { nativeChatAskDismissKey } from '../../../../../src/shared/native-chat-ask-dismiss-key'
import { MobileNativeChatPromptCard } from './MobileNativeChatPromptCard'
import { openExternalLink, useExternalLinkAvailable } from '../../../platform/external-link'
import { useMobileStructuredPromptResponses } from '../../use-mobile-structured-prompt-responses'
import { MobileNativeChatResolutionReceipt } from '../../MobileNativeChatResolutionReceipt'
import {
  projectStructuredPermission,
  type StructuredApprovalItem
} from '../../mobile-structured-agent-prompts'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../../src/shared/structured-agent-session-reducer'
import type { StructuredAgentSessionMutate } from '../../mobile-structured-agent-session-rpc'
vi.mock('../../../platform/external-link', () => ({
  openExternalLink: vi.fn(),
  useExternalLinkAvailable: vi.fn(() => true)
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios }
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  CircleHelp: 'CircleHelp',
  ShieldQuestion: 'ShieldQuestion',
  X: 'X'
}))
vi.mock('../../../components/MobileMarkdown', () => ({ MobileMarkdown: 'Markdown' }))

afterEach(async () => {
  await activateMobileUiLocale('en')
  mobileI18n.removeResourceBundle('fr', 'translation')
})

const textInput = (root: ReactTestInstance) =>
  root.find((node) => node.props.placeholder === 'Type your answer')
const ask = { questions: [{ question: 'Pick?', options: [{ label: 'East' }], multiSelect: false }] }

it('automatically hydrates a projected saved phone receipt and displays exact selected enum and complete text', async () => {
  const red = 'a'.repeat(4000) + 'r'.repeat(4000),
    blue = 'a'.repeat(4000) + 'b'.repeat(4000)
  const text = `  first\n${'x'.repeat(60000)}\nlast  `
  const exact: NativeChatResolvedPrompt = {
    kind: 'approval',
    title: 'Saved full form',
    detail: null,
    options: [],
    form: {
      fields: [
        {
          name: 'color',
          required: true,
          schema: { type: 'string', enum: [red, blue], enumNames: ['Red label', 'Blue label'] }
        },
        { name: 'text', required: true, schema: { type: 'string' } }
      ]
    },
    resolution: {
      state: 'resolved',
      selectedOptionId: null,
      resolvedBy: null,
      resolvedAt: null,
      formContent: { color: blue, text }
    }
  }
  const descriptor = {
    contract: AGENT_SESSION_SETTLED_BODY_CAPABILITY,
    version: 'approval-json.v1' as const,
    state: 'resolved' as const
  }
  const source = {
    ...descriptor,
    sessionId: 'session-alpha',
    epoch: 'epoch-1',
    itemId: 'item-1',
    revision: 2
  }
  const receipt = structuredQuestionTranscript([
    {
      itemId: source.itemId,
      revision: 2,
      sequence: 1,
      observedAt: 1,
      body: {
        ...exact,
        form: undefined,
        resolution: { ...exact.resolution, formContent: undefined }
      },
      settledBody: descriptor
    }
  ]).receipts.get(source.itemId)!
  const read = vi.fn(async (request: AgentSessionSettledBodyRead) => ({
    source,
    ...agentSessionJsonPiece(JSON.stringify(exact), request.cursor)
  }))
  const reader = createAgentSessionSettledBodyReader(read)
  let mounted!: ReactTestRenderer
  try {
    await act(async () => {
      mounted = create(
        createElement(
          MobileNativeChatSettledBodyContext.Provider,
          { value: { reader, sessionId: source.sessionId, epoch: source.epoch } },
          createElement(MobileNativeChatResolutionReceipt, { body: receipt, fontScale: 1 })
        )
      )
    })
    const nodes = mounted.root.findAll((node) => node.type === 'Text')
    expect(nodes.map((node) => node.children.join(''))).toContain('Blue label')
    expect(nodes.map((node) => node.children.join(''))).not.toContain('Red label')
    const answer = nodes.find((node) => node.children.join('') === text)
    expect(answer).toBeDefined()
    expect(answer!.props.numberOfLines).toBeUndefined()
    expect(read).toHaveBeenCalledTimes(Math.ceil(JSON.stringify(exact).length / 24576))
  } finally {
    await act(async () => mounted?.unmount())
    reader.dispose()
  }
})

it('renders saved whole-form receipt values on phone through the existing receipt component', async () => {
  let mounted!: ReactTestRenderer
  await act(async () => {
    mounted = create(
      createElement(MobileNativeChatResolutionReceipt, {
        fontScale: 1,
        body: {
          kind: 'approval',
          title: 'Configure report',
          detail: null,
          options: [],
          form: {
            fields: [
              { name: 'count', required: true, schema: { type: 'integer' } },
              { name: 'confirmed', required: true, schema: { type: 'boolean' } },
              {
                name: 'color',
                required: true,
                schema: {
                  type: 'string',
                  enum: ['red', 'blue'],
                  enumNames: ['Red label', 'Blue label']
                }
              },
              { name: 'space', required: true, schema: { type: 'string' } },
              { name: 'empty', required: false, schema: { type: 'string' } },
              {
                name: 'omitted',
                required: false,
                schema: { type: 'string', default: 'Do not restore' }
              }
            ]
          },
          resolution: {
            state: 'resolved',
            selectedOptionId: null,
            formContent: { count: 0, confirmed: false, color: 'red', space: '  ', empty: '' },
            resolvedBy: 'Desktop',
            resolvedAt: null
          }
        }
      })
    )
  })
  const text = mounted.root
    .findAll((node) => node.type === 'Text')
    .map((node) => node.children.join(''))
  for (const value of [
    'Configure report',
    'count',
    '0',
    'confirmed',
    'No',
    'Red label',
    '  ',
    'Empty answer'
  ]) {
    expect(text).toContain(value)
  }
  expect(text).not.toContain('omitted')
  expect(text).not.toContain('Selected answer unavailable')
  mobileI18n.addResourceBundle(
    'fr',
    'translation',
    { components: { 'native-chat': { form: { no: 'Non' } } } },
    true,
    true
  )
  await act(async () => {
    await activateMobileUiLocale('fr')
  })
  const french = mounted.root
    .findAll((node) => node.type === 'Text')
    .map((node) => node.children.join(''))
  expect(french).toContain('Non')
  expect(french).toContain('Red label')
  expect(french).toContain('0')
  expect(french).toContain('  ')
  expect(french).not.toContain('No')
  await act(async () => mounted.unmount())
})

it('submits the actual mobile form through its hook with exact defaults, editable invalid values, option replacement and optional omission', async () => {
  const prompt: StructuredApprovalItem = {
    itemId: 'form-item',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'approval',
      title: 'Enter values',
      detail: null,
      options: [
        { id: 'decline', label: 'Decline' },
        { id: 'cancel', label: 'Cancel' }
      ],
      form: {
        fields: [
          { name: 'count', required: true, schema: { type: 'integer', maximum: 10, default: 0 } },
          { name: 'confirmed', required: true, schema: { type: 'boolean', default: false } },
          {
            name: 'color',
            required: true,
            schema: { type: 'string', enum: ['blue', 'red'], default: 'blue' }
          },
          { name: 'name', required: true, schema: { type: 'string', default: '  ' } },
          { name: 'note', required: false, schema: { type: 'string', default: '' } }
        ]
      },
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
  const sent: Record<string, unknown>[] = []
  const mutate: StructuredAgentSessionMutate = async (method, fingerprint, fields) => {
    expect(method).toBe('agentSession.respondToApproval')
    expect(fingerprint).toBe('agentSession.respondTo:approval')
    sent.push(fields)
    return { status: 'rejected' }
  }
  let latestRespond: ReturnType<typeof useMobileStructuredPromptResponses>['respondPermission']
  function Form({
    supported = true,
    current = prompt,
    sourceKey = 'source-a'
  }: {
    supported?: boolean
    current?: StructuredApprovalItem
    sourceKey?: string
  }) {
    const stateRef = useRef({
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      status: 'ready' as const,
      items: [prompt]
    })
    useLayoutEffect(() => {
      stateRef.current = { ...stateRef.current, items: [current] }
    }, [current])
    const actions = useMobileStructuredPromptResponses({
      stateRef,
      sourceKey,
      mutate,
      formSubmitEnabled: supported,
      questionAnswersSupported: true,
      onSendError: vi.fn()
    })
    latestRespond = actions.respondPermission
    return createElement(MobileNativeChatPromptCard, {
      permission: projectStructuredPermission(current, supported, sourceKey),
      onRespondPermission: actions.respondPermission
    })
  }
  let tree: ReactTestRenderer | undefined
  try {
    await act(async () => {
      tree = create(createElement(Form))
    })
    const press = async (label: string) => {
      await act(async () => {
        await tree!.root.findByProps({ accessibilityLabel: label }).props.onPress()
      })
    }
    const edit = (label: string, value: string) => {
      act(() => tree!.root.findByProps({ accessibilityLabel: label }).props.onChangeText(value))
    }
    expect(sent).toEqual([])
    await press('Submit')
    expect(sent).toEqual([
      {
        itemId: 'form-item',
        expectedRevision: 1,
        content: { count: 0, confirmed: false, color: 'blue', name: '  ', note: '' }
      }
    ])
    edit('name', 'my draft')
    edit('count', '11')
    await press('Submit')
    expect(sent).toHaveLength(1)
    expect(tree!.root.findByProps({ accessibilityRole: 'alert' }).children.join('')).toContain(
      'at most 10'
    )
    await act(async () => {
      tree!.update(createElement(Form, { supported: false }))
    })
    expect(tree!.root.findByProps({ accessibilityLabel: 'Submit' }).props.disabled).toBe(true)
    expect(tree!.root.findByProps({ accessibilityRole: 'alert' }).children.join('')).toContain(
      'at most 10'
    )
    await press('Submit')
    expect(sent).toHaveLength(1)
    mobileI18n.addResourceBundle(
      'fr',
      'translation',
      {
        chat: { question: { submit: 'Valider' } },
        components: {
          'native-chat': {
            form: {
              no: 'Non',
              yes: 'Oui',
              clear: 'Effacer',
              clearField: 'Effacer {{field}}',
              optional: 'Facultatif',
              error: { maximum: 'Au plus {{maximum}}.' }
            }
          }
        }
      },
      true,
      true
    )
    await act(async () => {
      await activateMobileUiLocale('fr')
    })
    expect(tree!.root.findByProps({ accessibilityRole: 'alert' }).children.join('')).toBe(
      'Au plus 10.'
    )
    expect(tree!.root.findByProps({ accessibilityLabel: 'Valider' }).props.disabled).toBe(true)
    expect(
      tree!.root.findByProps({ accessibilityLabel: 'confirmed: Non' }).props.accessibilityState
        .checked
    ).toBe(true)
    expect(tree!.root.findByProps({ accessibilityLabel: 'Effacer note' })).toBeTruthy()
    await act(async () => {
      await activateMobileUiLocale('en')
    })
    expect(tree!.root.findByProps({ accessibilityRole: 'alert' }).children.join('')).toContain(
      'at most 10'
    )
    await act(async () => {
      tree!.update(createElement(Form, { supported: true }))
    })
    expect(tree!.root.findByProps({ accessibilityLabel: 'name' }).props.value).toBe('my draft')
    edit('count', '0')
    await press('Submit')
    expect(sent[1]).toMatchObject({ content: { name: 'my draft', count: 0, confirmed: false } })
    edit('name', '')
    await press('confirmed: Yes')
    await press('color: red')
    await press('Clear note')
    await press('Submit')
    expect(sent[2]).toEqual({
      itemId: 'form-item',
      expectedRevision: 1,
      content: { count: 0, confirmed: true, color: 'red', name: '' }
    })
    const defaultsForStale = { count: 0, confirmed: false, color: 'blue', name: '  ', note: '' }
    const stale = projectStructuredPermission(prompt, true, 'source-a')!.prompt
    for (const props of [
      { current: { ...prompt, revision: 2 } },
      { current: { ...prompt, itemId: 'replacement' } },
      { sourceKey: 'source-b' }
    ]) {
      edit('name', 'discard on replacement')
      await act(async () => {
        tree!.update(createElement(Form, props))
      })
      expect(tree!.root.findByProps({ accessibilityLabel: 'name' }).props.value).toBe('  ')
      const before = sent.length
      expect(await latestRespond!('', defaultsForStale, stale)).toBe(false)
      expect(sent).toHaveLength(before)
    }
  } finally {
    await act(async () => tree?.unmount())
  }
})

it('opens a structured sign-in link only on tap and answers separately', async () => {
  vi.mocked(openExternalLink).mockClear()
  const onRespondPermission = vi.fn(async () => true)
  let tree: ReactTestRenderer | undefined
  await act(async () => {
    tree = create(
      createElement(MobileNativeChatPromptCard, {
        permission: {
          title: 'Connect service',
          detail: 'https://example.com/connect',
          url: 'https://example.com/connect',
          options: [
            { label: 'Continue', send: 'accept' },
            { label: 'Decline', send: 'decline' }
          ]
        },
        onRespondPermission
      })
    )
  })
  expect(openExternalLink).not.toHaveBeenCalled()
  const opener = tree!.root
    .findAllByType(Pressable)
    .find(
      (button) =>
        button.props.accessibilityRole === 'button' &&
        button.findAll((node) => node.children.includes('Open link')).length > 0
    )!
  await act(async () => {
    opener.props.onPress()
  })
  expect(openExternalLink).toHaveBeenCalledWith('https://example.com/connect')
  expect(onRespondPermission).not.toHaveBeenCalled()
  await act(async () => {
    tree?.unmount()
  })
})

describe('MobileNativeChatPromptCard collapse', () => {
  it.each([true, false])(
    'shows only terminal navigation when answering requires it (%s)',
    async (available) => {
      const onAnswerInTerminal = vi.fn()
      const onAnswerAsk = vi.fn(async () => true)
      const onCancelAsk = vi.fn(async () => true)
      const onDismissAsk = vi.fn()
      let tree: ReactTestRenderer | null = null
      await act(async () => {
        tree = create(
          createElement(MobileNativeChatPromptCard, {
            ask,
            requiresTerminal: true,
            onAnswerAsk,
            onCancelAsk,
            onDismissAsk,
            onAnswerInTerminal: available ? onAnswerInTerminal : undefined
          })
        )
      })
      const buttons = tree!.root.findAllByType(Pressable)
      expect(buttons).toHaveLength(1)
      expect(buttons[0]!.props.accessibilityLabel).toBe('Answer in terminal')
      expect(buttons[0]!.props.disabled).toBe(!available)
      expect(tree!.root.findAllByType(TextInput)).toHaveLength(0)
      if (available) {
        act(() => buttons[0]!.props.onPress())
      }
      expect(onAnswerInTerminal).toHaveBeenCalledTimes(available ? 1 : 0)
      expect(onAnswerAsk).not.toHaveBeenCalled()
      expect(onCancelAsk).not.toHaveBeenCalled()
      expect(onDismissAsk).not.toHaveBeenCalled()
      act(() => tree!.unmount())
    }
  )

  it('keeps a partly answered Ask mounted but hidden while collapsed', async () => {
    let tree: ReactTestRenderer | null = null
    const render = (collapsed: boolean) =>
      createElement(MobileNativeChatPromptCard, {
        ask,
        collapsedPrompt: collapsed ? { title: 'Pick?', expand: () => {} } : null
      })
    await act(async () => {
      tree = create(render(false))
    })
    const other = tree!.root.findAll((node) => node.props.label === 'Other…')[0]!
    act(() => other.props.onPress())
    act(() => textInput(tree!.root).props.onChangeText('turbo'))

    await act(async () => tree!.update(render(true)))
    expect(tree!.root.findByProps({ testID: 'native-chat-prompt-strip' })).toBeTruthy()
    const hidden = tree!.root.findAll((node) => node.props.style?.display === 'none')
    expect(hidden).toHaveLength(1)
    expect(textInput(hidden[0]!).props.value).toBe('turbo')

    await act(async () => tree!.update(render(false)))
    expect(textInput(tree!.root).props.value).toBe('turbo')
    act(() => tree!.unmount())
  })
  it('resets stale pending choices/text on definition revision', async () => {
    let tree: ReactTestRenderer | null = null
    const render = (question: string) => {
      const prompt: AskPrompt = {
        ...ask,
        replyAsMessage: true,
        occurrenceIds: ['same-call'],
        questions: [{ ...ask.questions[0]!, question }]
      }
      return createElement(MobileNativeChatPromptCard, {
        ask: prompt,
        askKey: nativeChatAskDismissKey(prompt)
      })
    }
    await act(async () => {
      tree = create(render('Q1?'))
    })
    act(() => tree!.root.findAll((node) => node.props.label === 'Other…')[0]!.props.onPress())
    act(() => textInput(tree!.root).props.onChangeText('old answer'))
    await act(async () => tree!.update(render('Edited Q1?')))
    expect(tree!.root.findAllByType(TextInput)).toHaveLength(0)
    expect(tree!.root.findAll((node) => node.props.selected === true)).toHaveLength(0)
    act(() => tree!.unmount())
  })

  it('resets typed answers on a host/view owner change with the same portable prompt', async () => {
    const prompt: AskPrompt = { ...ask, replyAsMessage: true, occurrenceIds: ['same-portable-id'] }
    function Harness({ host }: { host: string }) {
      const dismissal = useMobileNativeChatAskDismiss({
        ask: prompt,
        startedAt: null,
        scopeKey: host,
        sessionKey: 'view',
        observing: true
      })
      return createElement(MobileNativeChatPromptCard, { ask: prompt, askKey: dismissal.askKey })
    }
    let tree: ReactTestRenderer | null = null
    await act(async () => {
      tree = create(createElement(Harness, { host: 'host-A' }))
    })
    act(() => tree!.root.findAll((node) => node.props.label === 'Other…')[0]!.props.onPress())
    act(() => textInput(tree!.root).props.onChangeText('old host answer'))
    await act(async () => tree!.update(createElement(Harness, { host: 'host-B' })))
    expect(tree!.root.findAllByType(TextInput)).toHaveLength(0)
    act(() => tree!.unmount())
  })
})

it('keeps the known Open control present disabled without support while decisions and the complete address remain available', async () => {
  vi.mocked(useExternalLinkAvailable).mockReturnValue(false)
  const url = `https://example.com/${'x'.repeat(8192 - 20)}`
  const answer = vi.fn(async () => true)
  let tree: ReactTestRenderer | undefined
  try {
    await act(async () => {
      tree = create(
        createElement(MobileNativeChatPromptCard, {
          permission: {
            title: 'Connect',
            url,
            detail: url,
            options: [
              { label: 'Continue', send: 'accept' },
              { label: 'Decline', send: 'decline' }
            ]
          },
          onRespondPermission: answer
        })
      )
    })
    const opener = tree!.root
      .findAllByType(Pressable)
      .find(
        (node) =>
          node.props.accessibilityRole === 'button' &&
          node.findAll((text) => text.children.includes('Open link')).length > 0
      )!
    expect(opener.props.disabled).toBe(true)
    expect(opener.props.accessibilityState).toEqual({ disabled: true })
    expect(
      tree!.root.findAll((node) => node.type === 'Text' && node.children.includes(url)).length
    ).toBeGreaterThan(0)
    const decision = tree!.root
      .findAllByType(Pressable)
      .find((node) => node.findAll((text) => text.children.includes('Continue')).length > 0)!
    expect(decision.props.disabled).toBe(false)
    await act(async () => {
      await decision.props.onPress()
    })
    expect(answer).toHaveBeenCalledWith('accept')
  } finally {
    await act(async () => tree?.unmount())
    vi.mocked(useExternalLinkAvailable).mockReturnValue(true)
  }
})
