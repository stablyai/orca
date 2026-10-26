import { createElement, createRef, StrictMode, type ComponentProps, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { Keyboard, type TextInput } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { radii, spacing } from '../theme/mobile-theme'
import { MobileNativeChatComposer as NativeChatComposer } from './MobileNativeChatComposer'
import { findAllByHostType, findByHostType } from '../test-support/react-test-renderer-host-nodes'

const getNoComposerEditGeneration = () => 0

function MobileNativeChatComposer({
  getComposerEditGeneration = getNoComposerEditGeneration,
  ...props
}: Omit<ComponentProps<typeof NativeChatComposer>, 'getComposerEditGeneration'> & {
  getComposerEditGeneration?: () => number
}): React.JSX.Element {
  return createElement(NativeChatComposer, { ...props, getComposerEditGeneration })
}

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    AccessibilityInfo: { announceForAccessibilityWithOptions: vi.fn() },
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Keyboard: { dismiss: vi.fn() },
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('ScrollView', props, children),
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 1
    },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View'
  }
})

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
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

vi.mock('../components/mounted-bottom-drawer', () => ({ MountedBottomDrawer: 'BottomDrawer' }))
vi.mock('../components/bottom-drawer-modal-host-scope', () => ({
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

  it('reports an accepted send without owning route-scoped draft cleanup', async () => {
    const onChangeText = vi.fn()
    const onSend = vi.fn().mockResolvedValue(true)
    await render(onSend, onChangeText)

    await act(async () => sendButton().props.onPress())

    // The send seam trims; preserve raw draft bytes when send rejects.
    expect(onSend).toHaveBeenCalledWith(' hello ')
    expect(onChangeText).not.toHaveBeenCalled()
  })

  it('stacks the input above the composer action row', async () => {
    await render(vi.fn().mockResolvedValue(true), vi.fn())

    const composer = renderer!.root.findByProps({ testID: 'native-chat-composer' })
    const inset = renderer!.root.findByProps({ testID: 'native-chat-composer-inset' })
    const actions = renderer!.root.findByProps({ testID: 'native-chat-composer-actions' })
    expect(findAllByHostType(composer, 'TextInput')).toHaveLength(1)
    expect(composer.children.at(-1)).toBe(actions)
    expect(inset.props.style).toMatchObject({ paddingBottom: spacing.sm })
    expect(composer.props.style).toMatchObject({ borderWidth: 1, borderRadius: radii.composer })
  })

  it('preserves leading whitespace so prose is not turned into a slash command', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: ' /clear is prose ',
          onChangeText: vi.fn(),
          onSend,
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration
        })
      )
    })
    await act(async () => sendButton().props.onPress())
    expect(onSend).toHaveBeenCalledWith(' /clear is prose ')
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

  it('blocks composer submission while a session-option command is pending', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: 'hello',
          onChangeText: vi.fn(),
          onSend,
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          sessionOptions: {
            isWorking: false,
            controller: {
              snapshot: [],
              pendingId: 'model',
              setOption: vi.fn(),
              invokeAction: vi.fn(),
              recordCommand: vi.fn()
            }
          }
        })
      )
    })
    expect(sendButton().props).toMatchObject({ disabled: true })
    await act(async () => sendButton().props.onPress())
    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps the draft when the send is rejected', async () => {
    const onChangeText = vi.fn()
    const onSend = vi.fn().mockResolvedValue(false)
    await render(onSend, onChangeText)

    await act(async () => sendButton().props.onPress())

    expect(onSend).toHaveBeenCalledWith(' hello ')
    expect(onChangeText).not.toHaveBeenCalled()
  })

  it('disables send while an attachment path is still being injected', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    await render(onSend, vi.fn(), true)

    expect(sendButton().props).toMatchObject({ disabled: true })
    await act(async () => sendButton().props.onPress())
    expect(onSend).not.toHaveBeenCalled()
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

  it('hands its owner the text field, so Edit can focus it', async () => {
    const focus = vi.fn()
    const inputRef = createRef<TextInput>()
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          inputRef,
          value: '',
          onChangeText: vi.fn(),
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration
        }),
        { createNodeMock: (element) => (element.type === 'TextInput' ? { focus } : null) }
      )
    })
    inputRef.current?.focus()
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('keeps one shape focused or not, and puts Stop in Send’s slot only while nothing is typed', async () => {
    let fieldMounts = 0
    const props = {
      onChangeText: vi.fn(),
      onSend: vi.fn().mockResolvedValue(true),
      onAttachImage: vi.fn(),
      onMicPress: vi.fn(),
      sendSurfaceId: 'tab-a',
      getSendCompletionGeneration: getCurrentSendCompletionGeneration,
      stop: { onStop: vi.fn(), held: false }
    }
    const draw = (value: string, sendDisabled = false) =>
      createElement(MobileNativeChatComposer, { ...props, value, sendDisabled })
    await act(async () => {
      renderer = create(draw(''), {
        createNodeMock: (element) => {
          fieldMounts += element.type === 'TextInput' ? 1 : 0
          return {}
        }
      })
    })
    const bar = () => renderer!.root.findByProps({ testID: 'native-chat-composer' })
    const labelled = (label: string) => renderer!.root.findAllByProps({ accessibilityLabel: label })
    const field = () => findByHostType(renderer!.root, 'TextInput')
    const unfocused = bar().props.style
    expect(labelled('Stop the agent')).toHaveLength(1)
    expect(labelled('Send message')).toHaveLength(0)

    await act(async () => field().props.onFocus())
    expect(bar().props.style).toBe(unfocused)
    await act(async () => field().props.onBlur())

    await act(async () => renderer!.update(draw('queue this')))
    expect(bar().props.style).toBe(unfocused)
    expect(labelled('Send message')).toHaveLength(1)
    await act(async () => renderer!.update(draw('queue this', true)))
    expect(labelled('Stop the agent')).toHaveLength(1)
    expect(fieldMounts).toBe(1)
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
    await press('Model, Model effort')
    await act(async () => field().props.onBlur())
    await press('effort, Not set')
    await press('Back to models')
    await press('Close picker')
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

  it('renders a removable thumbnail for each pending image attachment', async () => {
    const onRemoveAttachment = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: '',
          onChangeText: vi.fn(),
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          attachments: [
            { id: 'img-1', path: '/tmp/a.png', previewUri: 'file:///a.png' },
            { id: 'img-2', path: '/tmp/b.png', previewUri: 'file:///b.png' }
          ],
          onRemoveAttachment
        })
      )
    })
    const thumbs = findAllByHostType(renderer!.root, 'Image')
    expect(thumbs.map((t) => t.props.source.uri)).toEqual(['file:///a.png', 'file:///b.png'])

    const remove = findAllByHostType(renderer!.root, 'Pressable').filter(
      (node) => node.props.accessibilityLabel === 'Remove image'
    )
    remove[1].props.onPress()
    expect(onRemoveAttachment).toHaveBeenCalledWith('img-2')
  })

  it('enables send with an attached image even when the text is empty', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: '',
          onChangeText: vi.fn(),
          onSend,
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          attachments: [{ id: 'img-1', path: '/tmp/a.png', previewUri: 'file:///a.png' }]
        })
      )
    })
    expect(sendButton().props).toMatchObject({ disabled: false })
    await act(async () => sendButton().props.onPress())
    expect(onSend).toHaveBeenCalledWith('')
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

  it('serves the active agent’s shared command catalog with descriptions', async () => {
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: '/',
          onChangeText: vi.fn(),
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          agent: 'codex'
        })
      )
    })
    const input = findByHostType(renderer!.root, 'TextInput')
    await act(async () => input.props.onSelectionChange({ nativeEvent: { selection: { end: 1 } } }))
    const texts = findAllByHostType(renderer!.root, 'Text').map((node) => node.props.children)
    expect(texts).toContain('/permissions')
    expect(texts).toContain('Choose what Codex is allowed to do')
    expect(texts).not.toContain('/cost')
  })

  it('wires the mic for hold vs toggle dictation like the terminal composer', async () => {
    const onMicPress = vi.fn()
    const onMicPressIn = vi.fn()
    const onMicPressOut = vi.fn()
    const mic = () =>
      renderer!.root.find(
        (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Dictate'
      )

    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: '',
          onChangeText: vi.fn(),
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          onMicPress,
          dictationMode: 'hold',
          onMicPressIn,
          onMicPressOut
        })
      )
    })
    expect(mic().props.onPress).toBeUndefined()
    expect(mic().props.onPressIn).toBe(onMicPressIn)
    expect(mic().props.onPressOut).toBe(onMicPressOut)

    await act(async () => {
      renderer!.update(
        createElement(MobileNativeChatComposer, {
          value: '',
          onChangeText: vi.fn(),
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          onMicPress,
          dictationMode: 'toggle',
          onMicPressIn,
          onMicPressOut
        })
      )
    })
    expect(mic().props.onPress).toBe(onMicPress)
    expect(mic().props.onPressIn).toBeUndefined()
    expect(mic().props.onPressOut).toBeUndefined()
  })

  it('dismisses the keyboard once a send is accepted', async () => {
    vi.mocked(Keyboard.dismiss).mockClear()
    await render(vi.fn().mockResolvedValue(true), vi.fn())

    await act(async () => sendButton().props.onPress())

    expect(Keyboard.dismiss).toHaveBeenCalledTimes(1)
  })

  it('dismisses an accepted send after Strict Mode replays mount effects', async () => {
    vi.mocked(Keyboard.dismiss).mockClear()
    await act(async () => {
      renderer = create(
        createElement(
          StrictMode,
          null,
          createElement(MobileNativeChatComposer, {
            value: 'hello',
            onChangeText: vi.fn(),
            onSend: vi.fn().mockResolvedValue(true),
            sendSurfaceId: 'tab-a',
            getSendCompletionGeneration: getCurrentSendCompletionGeneration
          })
        )
      )
    })

    await act(async () => sendButton().props.onPress())

    expect(Keyboard.dismiss).toHaveBeenCalledTimes(1)
  })

  it('keeps the keyboard up when the send is rejected', async () => {
    // Keep the keyboard after rejection so the draft can be corrected and retried.
    vi.mocked(Keyboard.dismiss).mockClear()
    await render(vi.fn().mockResolvedValue(false), vi.fn())

    await act(async () => sendButton().props.onPress())

    expect(Keyboard.dismiss).not.toHaveBeenCalled()
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
