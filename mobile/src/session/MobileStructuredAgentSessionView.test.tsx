import { createElement, type ComponentProps } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'
import { MobileStructuredAgentSessionView } from './MobileStructuredAgentSessionView'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  FlatList: 'FlatList',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ Square: 'Square' }))
vi.mock('./MobileNativeChatComposer', () => ({
  MobileNativeChatComposer: 'MobileNativeChatComposer'
}))
vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'MobileNativeChatMessage' }))
vi.mock('./MobileStructuredPromptCard', () => ({
  MobileStructuredPromptCard: 'MobileStructuredPromptCard'
}))
vi.mock('./mobile-structured-agent-session-view-styles', () => ({
  styles: new Proxy({}, { get: () => ({}) })
}))

function options(): MobileNativeChatSessionOptionsController {
  return {
    snapshot: [
      {
        id: 'model',
        label: 'Model',
        category: 'model',
        kind: {
          type: 'select',
          currentValue: 'gpt-live',
          choices: [{ value: 'gpt-live', label: 'GPT Live' }]
        },
        valueSource: 'reported',
        settable: true
      }
    ],
    pendingId: null,
    setOption: vi.fn(async () => true),
    invokeAction: vi.fn(async () => true),
    recordCommand: vi.fn()
  }
}

describe('MobileStructuredAgentSessionView command seam', () => {
  let renderer: ReactTestRenderer | null = null
  const onSend = vi.fn(async () => true)
  let controller: MobileNativeChatSessionOptionsController

  function props(
    overrides: Partial<ComponentProps<typeof MobileStructuredAgentSessionView>> = {}
  ): ComponentProps<typeof MobileStructuredAgentSessionView> {
    return {
      items: [],
      status: 'ready',
      hasOlder: false,
      loadingOlder: false,
      onLoadOlder: async () => false,
      outbox: [],
      onSend,
      onTakeQueuedForEdit: async () => null,
      onRetry: async () => {},
      onRespondToPrompt: async () => true,
      sessionOptions: controller,
      attachments: [],
      isAttaching: false,
      onAttachImage: () => {},
      onRemoveAttachment: () => {},
      onCancel: async () => true,
      ...overrides
    }
  }

  function render(overrides = {}): void {
    act(() => {
      renderer = create(createElement(MobileStructuredAgentSessionView, props(overrides)))
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    onSend.mockClear()
    controller = options()
    render()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function submit(text: string): Promise<void> {
    const composer = renderer!.root.findByType('MobileNativeChatComposer')
    act(() => composer.props.onChangeText(text))
    await act(async () => {
      await renderer!.root.findByType('MobileNativeChatComposer').props.onSend(text)
    })
  }

  it('opens the structured model picker without issuing a chat send', async () => {
    await submit('/model')

    expect(controller.invokeAction).toHaveBeenCalledWith('model')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('renders an explicit refusal for unsupported advertised commands', async () => {
    await submit('/review')

    expect(onSend).not.toHaveBeenCalled()
    expect(
      renderer!.root.findByProps({ accessibilityRole: 'alert' }).findByType('Text').children
    ).toEqual(['/review is not available in chat sessions.'])
  })

  it('keeps native ownership on the structured agent-session send path', async () => {
    await submit('native message')

    expect(onSend).toHaveBeenCalledWith('native message', [])
  })
})
