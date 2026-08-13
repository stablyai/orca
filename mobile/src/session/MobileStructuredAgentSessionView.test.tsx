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
  const onTuiSend = vi.fn(async () => true)
  let controller: MobileNativeChatSessionOptionsController

  function props(
    overrides: Partial<ComponentProps<typeof MobileStructuredAgentSessionView>> = {}
  ): ComponentProps<typeof MobileStructuredAgentSessionView> {
    return {
      agent: 'codex',
      items: [],
      status: 'ready',
      hasOlder: false,
      loadingOlder: false,
      onLoadOlder: async () => false,
      outbox: [],
      onSend,
      onTuiSend,
      onTakeQueuedForEdit: async () => null,
      onRetry: async () => {},
      onRespondToPrompt: async () => true,
      sessionOptions: controller,
      attachments: [],
      isAttaching: false,
      onAttachImage: () => {},
      onRemoveAttachment: () => {},
      onCancel: async () => true,
      handoff: null,
      onRequestHandoff: async () => true,
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
    onTuiSend.mockClear()
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

  it('uses Claude branding and command suggestions for Claude sessions', () => {
    act(() => {
      renderer!.update(createElement(MobileStructuredAgentSessionView, props({ agent: 'claude' })))
    })

    const composer = renderer!.root.findByType('MobileNativeChatComposer')
    expect(composer.props).toMatchObject({ agent: 'claude', placeholder: 'Message Claude' })
    expect(composer.props.slashCommands.map((command: { name: string }) => command.name)).toEqual([
      'model',
      'effort',
      'clear',
      'compact',
      'init',
      'review',
      'help'
    ])
    const empty = renderer!.root.findByType('FlatList').props.ListEmptyComponent
    expect(empty.props.children[0].props.children).toBe('New Claude chat')
  })

  it('keeps the composer enabled and routes stable TUI ownership through its bridge', async () => {
    act(() => {
      renderer!.update(
        createElement(
          MobileStructuredAgentSessionView,
          props({
            handoff: {
              owner: 'tui',
              direction: null,
              phase: 'idle',
              stage: null,
              operationId: null,
              terminal: { handle: 'term-tui', tabId: 'tab-tui', paneKey: 'pane-tui' }
            }
          })
        )
      )
    })

    expect(renderer!.root.findByType('MobileNativeChatComposer').props.disabled).toBe(false)
    await submit('hello from mobile')
    expect(onTuiSend).toHaveBeenCalledWith('hello from mobile', [])
    expect(onSend).not.toHaveBeenCalled()
  })

  it('routes stable TUI slash commands to typed terminal dispatch', async () => {
    act(() => {
      renderer!.update(
        createElement(
          MobileStructuredAgentSessionView,
          props({
            handoff: {
              owner: 'tui',
              direction: null,
              phase: 'idle',
              stage: null,
              operationId: null,
              terminal: { handle: 'term-tui', tabId: 'tab-tui', paneKey: 'pane-tui' }
            }
          })
        )
      )
    })

    await submit('/model')
    expect(onTuiSend).toHaveBeenCalledWith('/model', [])
    expect(controller.invokeAction).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('disables and refuses composer sends while ownership is switching', async () => {
    act(() => {
      renderer!.update(
        createElement(
          MobileStructuredAgentSessionView,
          props({
            handoff: {
              owner: 'native',
              direction: 'to-tui',
              phase: 'switching',
              stage: 'preparing',
              operationId: 'handoff-1'
            }
          })
        )
      )
    })

    const composer = renderer!.root.findByType('MobileNativeChatComposer')
    expect(composer.props.disabled).toBe(true)
    await act(async () => {
      expect(await composer.props.onSend('racing send')).toBe(false)
    })
    expect(onSend).not.toHaveBeenCalled()
    expect(onTuiSend).not.toHaveBeenCalled()
  })

  it('keeps native ownership on the structured agent-session send path', async () => {
    await submit('native message')

    expect(onSend).toHaveBeenCalledWith('native message', [])
    expect(onTuiSend).not.toHaveBeenCalled()
  })
})
