import { createElement, type ComponentProps, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { Keyboard } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  useMobileNativeChatDraft,
  setMobileNativeChatDraftText
} from './mobile-native-chat-draft-store'

import { MobileNativeChatComposer as NativeChatComposer } from './MobileNativeChatComposer'
import {
  findAllByHostType,
  findByHostType
} from '../../../test-support/react-test-renderer-host-nodes'

import {
  captureMobileNativeChatTextDestination,
  updateMobileNativeChatDraftInputs
} from './mobile-native-chat-draft-inputs'

const getNoComposerEditGeneration = () => 0

function MobileNativeChatComposer({
  getComposerEditGeneration = getNoComposerEditGeneration,
  ...props
}: Omit<ComponentProps<typeof NativeChatComposer>, 'getComposerEditGeneration'> & {
  getComposerEditGeneration?: () => number
}): React.JSX.Element {
  return createElement(NativeChatComposer, { ...props, getComposerEditGeneration })
}

vi.mock('../../../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
vi.mock('./MobileNativeChatContextUsageRing', () => ({
  useMobileNativeChatContextRing: () => ({ barProps: {}, ring: null })
}))
// BottomDrawer also carries the option pager, which loads Reanimated at import.
vi.mock('react-native-reanimated', async () =>
  (await import('../../../test-support/reanimated-pager-stub')).reanimatedPagerStub()
)
vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ...(await import('../../../test-support/react-native-motion-stub')).reactNativeMotionStub(),
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Keyboard: { dismiss: vi.fn() },
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('ScrollView', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View'
  }
})

vi.mock('lucide-react-native', () => ({
  AtSign: 'AtSign',
  Image: 'Image',
  Paperclip: 'Paperclip',
  ArrowUp: 'ArrowUp',
  ListEnd: 'ListEnd',
  CornerDownRight: 'CornerDownRight',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  FileText: 'FileText',
  Mic: 'Mic',
  Package: 'Package',
  Plus: 'Plus',
  ShieldAlert: 'ShieldAlert',
  Square: 'Square',
  Terminal: 'Terminal',
  X: 'X'
}))

vi.mock('../../../components/bottom-drawer/mounted-bottom-drawer', () => ({
  MountedBottomDrawer: 'BottomDrawer'
}))
vi.mock('../../../components/bottom-drawer/bottom-drawer-modal-host-scope', () => ({
  useBottomDrawerModalHost: () => null
}))

describe('MobileNativeChatComposer', () => {
  let renderer: ReactTestRenderer | null = null
  const getCurrentSendCompletionGeneration = () => 0

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function render(
    onSend: (text: string) => Promise<boolean>,
    onChangeText: (text: string) => void,
    isAttaching = false,
    sendSurfaceId = 'tab-a',
    getSendCompletionGeneration = () => 0
  ) {
    let composerEditGeneration = 0
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: ' hello ',
          onChangeText: (text) => {
            composerEditGeneration += 1
            onChangeText(text)
          },
          onSend,
          sendSurfaceId,
          getSendCompletionGeneration,
          getComposerEditGeneration: () => composerEditGeneration,
          isAttaching
        })
      )
    })
  }

  function sendButton(): ReactTestInstance {
    if (!renderer) {
      throw new Error('Composer was not rendered')
    }
    return renderer.root.find(
      (node) =>
        String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Send message'
    )
  }

  it('opens MCP controls without sending or consuming the draft, while a picked same-name skill still sends', async () => {
    const request = vi.fn(async () => ({ status: 'ok' as const, servers: [] }))
    const onSend = vi.fn(async () => true)
    const onChangeText = vi.fn()
    const props = {
      agent: 'claude',
      value: '/mcp',
      onSend,
      onChangeText,
      sendSurfaceId: 'mcp-chat',
      getSendCompletionGeneration: () => 0,
      structured: {
        catalog: { reported: [], conversationCommands: [] },
        onSlashMenuOpen: () => {},
        files: [],
        onRemoveFile: () => {},
        mcp: { sessionKey: 'mcp-session', request }
      }
    }
    await act(async () => {
      renderer = create(createElement(MobileNativeChatComposer, props))
    })
    await act(async () => sendButton().props.onPress())
    expect(request).toHaveBeenCalledWith({ action: 'status' })
    expect(onSend).not.toHaveBeenCalled()
    expect(onChangeText).not.toHaveBeenCalled()
    act(() => renderer?.unmount())
    updateMobileNativeChatDraftInputs('mcp-chat', () => ({
      images: [],
      files: [],
      skills: [{ name: 'mcp', path: '/workspace/mcp/SKILL.md' }]
    }))
    await act(async () => {
      renderer = create(createElement(MobileNativeChatComposer, props))
    })
    await act(async () => sendButton().props.onPress())
    expect(onSend).toHaveBeenCalledWith('/mcp')
    updateMobileNativeChatDraftInputs('mcp-chat', () => ({ images: [], files: [], skills: [] }))
  })

  it('holds the MCP command entry until an in-flight message finishes', async () => {
    const sent = Promise.withResolvers<boolean>()
    const request = vi.fn(async () => ({ status: 'ok' as const, servers: [] }))
    const draw = (value: string) =>
      createElement(MobileNativeChatComposer, {
        agent: 'claude',
        value,
        onSend: () => sent.promise,
        onChangeText: vi.fn(),
        sendSurfaceId: 'mcp-send-lock',
        getSendCompletionGeneration: () => 0,
        structured: {
          catalog: { reported: [], conversationCommands: [] },
          onSlashMenuOpen: () => {},
          files: [],
          onRemoveFile: () => {},
          mcp: { sessionKey: 'mcp-send-lock', request }
        }
      })
    await act(async () => {
      renderer = create(draw('hello'))
    })
    let pendingSend!: Promise<void>
    await act(async () => {
      pendingSend = sendButton().props.onPress()
    })
    await act(async () => renderer!.update(draw('/mcp')))
    const commandEntry = () =>
      renderer!.root.find(
        (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === '/mcp'
      )
    expect(commandEntry().props.disabled).toBe(true)
    await act(async () => commandEntry().props.onPress())
    expect(request).not.toHaveBeenCalled()
    await act(async () => {
      sent.resolve(true)
      await pendingSend
    })
    await act(async () => commandEntry().props.onPress())
    expect(request).toHaveBeenCalledWith({ action: 'status' })
  })

  it('appends dictation until a selection is read, then replaces the selection it started on', async () => {
    const scope = 'dictation-ordinary'
    setMobileNativeChatDraftText(scope, 'Ok')
    function Registered() {
      const value = useMobileNativeChatDraft(scope)
      return createElement(MobileNativeChatComposer, {
        value,
        draftScopeKey: scope,
        onChangeText: (text) => setMobileNativeChatDraftText(scope, text),
        onSend: async () => true,
        sendSurfaceId: scope,
        getSendCompletionGeneration: () => 0
      })
    }
    await act(async () => {
      renderer = create(createElement(Registered))
    })
    const input = () => findByHostType(renderer!.root, 'TextInput')
    const say = (text: string) =>
      act(() => void captureMobileNativeChatTextDestination()!.insert(text))
    const select = (start: number, end: number) =>
      input().props.onSelectionChange({ nativeEvent: { selection: { start, end }, text: 'Ok hi' } })
    act(() => input().props.onFocus())
    say('hi')
    act(() => select(3, 5))
    const destination = captureMobileNativeChatTextDestination()!
    // A tap elsewhere while talking doesn't move where the words land.
    act(() => {
      select(0, 0)
      destination.insert('there')
    })
    expect(input().props.value).toBe('Ok there')
    say('now')
    expect(input().props.value).toBe('Ok there now')
  })

  it('locks pickers during a pending send while keeping Stop and the next draft usable', async () => {
    // Apply during the host’s body/Enter delay would become part of the prompt.
    let releaseSend: ((accepted: boolean) => void) | undefined
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseSend = resolve
        })
    )
    const controller = {
      snapshot: [
        {
          id: 'model',
          label: 'Model',
          category: 'model' as const,
          kind: {
            type: 'select' as const,
            choices: [
              { value: 'sonnet', label: 'Sonnet 5' },
              { value: 'opus', label: 'Opus 4.8' }
            ]
          },
          valueSource: 'unknown' as const,
          transport: 'catalog' as const,
          settable: true
        }
      ],
      pendingId: null,
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      recordCommand: vi.fn()
    }
    const onStop = vi.fn()
    const draw = (value: string) =>
      createElement(MobileNativeChatComposer, {
        value,
        onChangeText: vi.fn(),
        onSend,
        sendSurfaceId: 'tab-a',
        getSendCompletionGeneration: getCurrentSendCompletionGeneration,
        sessionOptions: { isWorking: false, controller },
        stop: { onStop, held: false }
      })
    await act(async () => {
      renderer = create(draw('run the tests'))
    })
    const modelPill = () =>
      renderer!.root.find(
        (node) =>
          String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Model, Model'
      )
    expect(modelPill().props.accessibilityState).toMatchObject({ disabled: false })
    let pressed!: Promise<void>
    await act(async () => {
      pressed = sendButton().props.onPress()
      await Promise.resolve()
    })
    expect(onSend).toHaveBeenCalled()
    await act(async () => renderer!.update(draw('')))
    await act(async () => renderer!.update(draw('next draft')))
    await act(async () =>
      renderer!.root.findByProps({ accessibilityLabel: 'Stop the agent' }).props.onPress()
    )
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(findByHostType(renderer!.root, 'TextInput').props.value).toBe('next draft')
    expect(modelPill().props.accessibilityState).toMatchObject({ disabled: true })
    await act(async () => {
      releaseSend?.(true)
      await pressed
    })
    expect(modelPill().props.accessibilityState).toMatchObject({ disabled: false })
    expect(sendButton().props.disabled).toBe(false)
  })

  it('retains an editable draft through a send lock and can send it after unlocking', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const onChangeText = vi.fn()
    vi.mocked(Keyboard.dismiss).mockClear()
    const draw = (disabled: boolean, value = 'half-typed') =>
      createElement(MobileNativeChatComposer, {
        value,
        onChangeText,
        onSend,
        sendSurfaceId: 'tab-a',
        getSendCompletionGeneration: getCurrentSendCompletionGeneration,
        disabled
      })
    await act(async () => {
      renderer = create(draw(false))
    })
    const input = () => findByHostType(renderer!.root, 'TextInput')
    const originalInput = input()
    await act(async () => input().props.onFocus())
    await act(async () => renderer!.update(draw(true)))
    // Do not revoke editable: iOS resigns first responder and closes the keyboard.
    expect(input()).toBe(originalInput)
    expect(input().props.editable).not.toBe(false)
    expect(sendButton().props).toMatchObject({ disabled: true })
    await act(async () => sendButton().props.onPress())
    expect(onSend).not.toHaveBeenCalled()
    expect(onChangeText).not.toHaveBeenCalled()
    expect(input().props.value).toBe('half-typed')
    expect(Keyboard.dismiss).not.toHaveBeenCalled()

    await act(async () => input().props.onChangeText('finished draft'))
    expect(onChangeText).toHaveBeenCalledWith('finished draft')
    await act(async () => renderer!.update(draw(true, 'finished draft')))
    expect(input().props.value).toBe('finished draft')
    await act(async () => renderer!.update(draw(false, 'finished draft')))
    expect(input()).toBe(originalInput)
    expect(sendButton().props).toMatchObject({ disabled: false })
    await act(async () => sendButton().props.onPress())
    expect(onSend).toHaveBeenCalledExactlyOnceWith('finished draft')
  })

  it('holds each picker through dismissal and restores only pill-displaced focus', async () => {
    const focus = vi.fn()
    const controller = {
      snapshot: ['model', 'effort'].map((id) => ({
        id,
        label: id,
        category: id === 'model' ? ('model' as const) : ('thought_level' as const),
        kind: { type: 'select' as const, choices: [] },
        valueSource: 'unknown' as const,
        transport: 'catalog' as const,
        settable: true
      })),
      pendingId: null,
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      recordCommand: vi.fn(),
      optionPickerRequest: { id: 'model', sequence: 0 }
    }
    const draw = () =>
      createElement(MobileNativeChatComposer, {
        value: '',
        onChangeText: vi.fn(),
        onSend: vi.fn().mockResolvedValue(true),
        sendSurfaceId: 'tab-a',
        getSendCompletionGeneration: getCurrentSendCompletionGeneration,
        sessionOptions: { controller, isWorking: false }
      })
    await act(async () => {
      renderer = create(draw(), {
        createNodeMock: (element) => (element.type === 'TextInput' ? { focus } : null)
      })
    })
    const field = () => findByHostType(renderer!.root, 'TextInput')
    const press = async (label: string) =>
      act(async () => renderer!.root.findByProps({ accessibilityLabel: label }).props.onPress())
    expect(findAllByHostType(renderer!.root, 'BottomDrawer')).toHaveLength(0)
    await act(async () => field().props.onFocus())
    await press('Model, Model')
    await act(async () => field().props.onBlur())
    await press('Effort, Not set')
    await press('Back to models')
    await press('Done')
    await act(async () => findByHostType(renderer!.root, 'BottomDrawer').props.onHidden())
    expect(focus).toHaveBeenCalledTimes(1)
    for (const id of ['model', 'effort']) {
      await act(async () => field().props.onFocus())
      controller.optionPickerRequest = { id, sequence: controller.optionPickerRequest.sequence + 1 }
      await act(async () => renderer!.update(draw()))
      await act(async () => field().props.onBlur())
      await act(async () => findByHostType(renderer!.root, 'BottomDrawer').props.onClose())
      await act(async () => findByHostType(renderer!.root, 'BottomDrawer').props.onHidden())
      expect(focus).toHaveBeenCalledTimes(1)
    }
    await act(async () => renderer!.unmount())
    await act(async () => {
      renderer = create(draw())
    })
    expect(findAllByHostType(renderer!.root, 'BottomDrawer')).toHaveLength(0)
  })

  it('moves the caret to the insert point after an autocomplete pick, then releases control', async () => {
    const onChangeText = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: '/c',
          onChangeText,
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          agent: 'claude'
        })
      )
    })
    const input = () => findByHostType(renderer!.root, 'TextInput')
    expect(input().props.selection).toBeUndefined()
    await act(async () =>
      input().props.onSelectionChange({ nativeEvent: { selection: { end: 2 } } })
    )
    const clear = renderer!.root.find(
      (node) => node.props.accessibilityLabel === '/clear' && node.props.onPress !== undefined
    )
    await act(async () => clear.props.onPress())
    expect(onChangeText).toHaveBeenCalledWith('/clear ')
    expect(input().props.selection).toEqual({ start: 7, end: 7 })
    await act(async () =>
      input().props.onSelectionChange({ nativeEvent: { selection: { end: 7 } } })
    )
    expect(input().props.selection).toBeUndefined()
  })

  it('does not dismiss a newly focused composer when an old accepted send settles', async () => {
    vi.mocked(Keyboard.dismiss).mockClear()
    let resolveSend: ((accepted: boolean) => void) | null = null
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve
        })
    )
    await render(onSend, vi.fn())

    let pendingSend!: Promise<void>
    await act(async () => {
      pendingSend = sendButton().props.onPress()
      await Promise.resolve()
    })
    await act(async () => {
      renderer!.update(
        createElement(MobileNativeChatComposer, {
          value: 'new surface draft',
          onChangeText: vi.fn(),
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-b',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration
        })
      )
    })
    await act(async () => {
      resolveSend?.(true)
      await pendingSend
    })

    expect(Keyboard.dismiss).not.toHaveBeenCalled()
  })

  it('does not dismiss after a newer edit on the same surface', async () => {
    vi.mocked(Keyboard.dismiss).mockClear()
    let resolveSend: ((accepted: boolean) => void) | null = null
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve
        })
    )
    await render(onSend, vi.fn())

    let pendingSend!: Promise<void>
    await act(async () => {
      pendingSend = sendButton().props.onPress()
      await Promise.resolve()
    })
    const input = findByHostType(renderer!.root, 'TextInput')
    await act(async () => input.props.onChangeText('newer draft'))
    await act(async () => {
      resolveSend?.(true)
      await pendingSend
    })

    expect(Keyboard.dismiss).not.toHaveBeenCalled()
  })

  it('does not dismiss after autocomplete mutates the same surface', async () => {
    vi.mocked(Keyboard.dismiss).mockClear()
    let editGeneration = 0
    let resolveSend: ((accepted: boolean) => void) | null = null
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve
        })
    )
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: '/c',
          onChangeText: () => {
            editGeneration += 1
          },
          onSend,
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          getComposerEditGeneration: () => editGeneration,
          agent: 'claude'
        })
      )
    })
    const input = findByHostType(renderer!.root, 'TextInput')
    await act(async () => input.props.onSelectionChange({ nativeEvent: { selection: { end: 2 } } }))

    let pendingSend!: Promise<void>
    await act(async () => {
      pendingSend = sendButton().props.onPress()
      await Promise.resolve()
    })
    const suggestion = renderer!.root.find(
      (node) => node.props.accessibilityLabel === '/clear' && node.props.onPress !== undefined
    )
    await act(async () => suggestion.props.onPress())
    await act(async () => {
      resolveSend?.(true)
      await pendingSend
    })

    expect(Keyboard.dismiss).not.toHaveBeenCalled()
  })

  it('does not dismiss after dictation mutates the controlled draft', async () => {
    vi.mocked(Keyboard.dismiss).mockClear()
    let editGeneration = 0
    let resolveSend: ((accepted: boolean) => void) | null = null
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve
        })
    )
    const props = {
      value: 'hello',
      onChangeText: vi.fn(),
      onSend,
      sendSurfaceId: 'tab-a',
      getSendCompletionGeneration: getCurrentSendCompletionGeneration,
      getComposerEditGeneration: () => editGeneration
    }
    await act(async () => {
      renderer = create(createElement(MobileNativeChatComposer, props))
    })

    let pendingSend!: Promise<void>
    await act(async () => {
      pendingSend = sendButton().props.onPress()
      await Promise.resolve()
    })
    editGeneration += 1
    await act(async () => {
      renderer!.update(
        createElement(MobileNativeChatComposer, { ...props, value: 'hello dictated text' })
      )
    })
    await act(async () => {
      resolveSend?.(true)
      await pendingSend
    })

    expect(Keyboard.dismiss).not.toHaveBeenCalled()
  })

  it('does not dismiss after its retained route loses focus', async () => {
    vi.mocked(Keyboard.dismiss).mockClear()
    let generation = 0
    let resolveSend: ((accepted: boolean) => void) | null = null
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSend = resolve
        })
    )
    await render(onSend, vi.fn(), false, 'tab-a', () => generation)

    let pendingSend!: Promise<void>
    await act(async () => {
      pendingSend = sendButton().props.onPress()
      await Promise.resolve()
    })
    generation += 1
    await act(async () => {
      resolveSend?.(true)
      await pendingSend
    })

    expect(Keyboard.dismiss).not.toHaveBeenCalled()
  })
})
