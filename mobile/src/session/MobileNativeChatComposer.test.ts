import { createElement, StrictMode, type ComponentProps } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { Keyboard } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { radii, spacing } from '../theme/mobile-theme'
import { MobileNativeChatComposer as NativeChatComposer } from './MobileNativeChatComposer'

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
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Keyboard: { dismiss: vi.fn() },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: unknown }) =>
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
  ImagePlus: 'ImagePlus',
  Mic: 'Mic',
  Square: 'Square',
  X: 'X'
}))

vi.mock('../components/BottomDrawer', async () => {
  const React = await import('react')
  return {
    BottomDrawer: ({ visible, children }: { visible: boolean; children?: unknown }) =>
      visible ? React.createElement('BottomDrawer', { visible }, children) : null
  }
})

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

  function sendButton(): { props: { onPress: () => Promise<void> } } {
    if (!renderer) {
      throw new Error('Composer was not rendered')
    }
    return renderer.root.find(
      (node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Send message'
    ) as { props: { onPress: () => Promise<void> } }
  }

  it('reports an accepted send without owning route-scoped draft cleanup', async () => {
    const onChangeText = vi.fn()
    const onSend = vi.fn().mockResolvedValue(true)
    await render(onSend, onChangeText)

    await act(async () => sendButton().props.onPress())

    // Verbatim: the send seam trims for the wire, so a rejected send can hand
    // back the draft byte-for-byte (#14819).
    expect(onSend).toHaveBeenCalledWith(' hello ')
    expect(onChangeText).not.toHaveBeenCalled()
  })

  it('stacks the input above the composer action row', async () => {
    await render(vi.fn().mockResolvedValue(true), vi.fn())

    const composer = renderer!.root.findByProps({ testID: 'native-chat-composer' })
    const inset = renderer!.root.findByProps({ testID: 'native-chat-composer-inset' })
    const actions = renderer!.root.findByProps({ testID: 'native-chat-composer-actions' })
    expect(composer.findAllByType('TextInput')).toHaveLength(1)
    expect(composer.children[1]).toBe(actions)
    expect(inset.props.style).toMatchObject({
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md
    })
    expect(composer.props.style).toMatchObject({
      borderWidth: 1,
      borderRadius: radii.card,
      overflow: 'hidden'
    })
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

  it('locks the option pickers while a composer send is in flight', async () => {
    // The reverse of the test below. The host spaces a send's body and its Enter
    // ~500ms apart, so an apply tapped inside that window would be submitted as
    // part of the user's prompt instead of running as its own command.
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
          settable: true
        }
      ],
      pendingId: null,
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      recordCommand: vi.fn()
    }
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: 'run the tests',
          onChangeText: vi.fn(),
          onSend,
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          sessionOptions: { isWorking: false, controller }
        })
      )
    })
    const modelPill = (): { props: { accessibilityState: { disabled: boolean } } } =>
      renderer!.root.find(
        (node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Model, Model'
      ) as { props: { accessibilityState: { disabled: boolean } } }
    expect(modelPill().props.accessibilityState).toMatchObject({ disabled: false })
    // Start the send but don't await it — it stays in flight on purpose.
    let pressed!: Promise<void>
    await act(async () => {
      pressed = sendButton().props.onPress()
      await Promise.resolve()
    })
    expect(onSend).toHaveBeenCalled()
    expect(modelPill().props.accessibilityState).toMatchObject({ disabled: true })
    await act(async () => {
      releaseSend?.(true)
      await pressed
    })
    expect(modelPill().props.accessibilityState).toMatchObject({ disabled: false })
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

  it('keeps the text input editable while the send is locked', async () => {
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatComposer, {
          value: 'half-typed',
          onChangeText: vi.fn(),
          onSend: vi.fn().mockResolvedValue(true),
          sendSurfaceId: 'tab-a',
          getSendCompletionGeneration: getCurrentSendCompletionGeneration,
          disabled: true
        })
      )
    })
    // Revoking `editable` on a focused field resigns first responder on iOS and
    // yanks the keyboard mid-typing (#10681) — the lock may only gate sending.
    const input = renderer!.root.find((node) => node.type === 'TextInput') as {
      props: { editable?: boolean }
    }
    expect(input.props.editable).not.toBe(false)
    expect(sendButton().props).toMatchObject({ disabled: true })
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
    const thumbs = renderer!.root.findAll((node) => node.type === 'Image') as Array<{
      props: { source: { uri: string } }
    }>
    expect(thumbs.map((t) => t.props.source.uri)).toEqual(['file:///a.png', 'file:///b.png'])

    const remove = renderer!.root.findAll(
      (node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Remove image'
    ) as Array<{ props: { onPress: () => void } }>
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
    const input = () =>
      renderer!.root.find((node) => node.type === 'TextInput') as {
        props: {
          selection?: { start: number; end: number }
          onSelectionChange: (e: { nativeEvent: { selection: { end: number } } }) => void
        }
      }
    // Uncontrolled selection until a suggestion is applied.
    expect(input().props.selection).toBeUndefined()
    // Place the caret at the end so the slash trigger is active and suggestions render.
    await act(async () =>
      input().props.onSelectionChange({ nativeEvent: { selection: { end: 2 } } })
    )
    const firstSuggestion = renderer!.root.findAll(
      (node) => node.type === 'Pressable' && !node.props.accessibilityLabel
    )[0] as { props: { onPress: () => void } }
    await act(async () => firstSuggestion.props.onPress())
    expect(onChangeText).toHaveBeenCalledWith('/clear ')
    // `/clear ` is 7 chars — the caret jumps just past the inserted command + space.
    expect(input().props.selection).toEqual({ start: 7, end: 7 })
    // The next native selection event releases control so manual placement still works.
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
    const input = renderer!.root.find((node) => node.type === 'TextInput') as {
      props: { onSelectionChange: (e: { nativeEvent: { selection: { end: number } } }) => void }
    }
    await act(async () => input.props.onSelectionChange({ nativeEvent: { selection: { end: 1 } } }))
    const texts = renderer!.root
      .findAll((node) => node.type === 'Text')
      .map((node) => (node.props as { children?: unknown }).children)
    // Codex-only commands from the shared catalog, with their description rows —
    // and none of the old hardcoded provider-agnostic list's phantom entries.
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
        (node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Dictate'
      ) as { props: { onPress?: unknown; onPressIn?: unknown; onPressOut?: unknown } }

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
    // Hold mode is walkie-talkie: press-in/out drive dictation, tap is inert.
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
    // Toggle mode: tap drives dictation, press-in/out inert.
    expect(mic().props.onPress).toBe(onMicPress)
    expect(mic().props.onPressIn).toBeUndefined()
    expect(mic().props.onPressOut).toBeUndefined()
  })

  it('dismisses the keyboard once a send is accepted', async () => {
    // Why: the reply the user is now waiting on sits behind the keyboard.
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
    // A rejected send hands the draft back for editing, so yanking the keyboard
    // would make the user re-open it to fix and retry.
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
    const input = renderer!.root.find((node) => node.type === 'TextInput') as {
      props: { onChangeText: (text: string) => void }
    }
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
    const input = renderer!.root.find((node) => node.type === 'TextInput') as {
      props: { onSelectionChange: (event: { nativeEvent: { selection: { end: number } } }) => void }
    }
    await act(async () => input.props.onSelectionChange({ nativeEvent: { selection: { end: 2 } } }))

    let pendingSend!: Promise<void>
    await act(async () => {
      pendingSend = sendButton().props.onPress()
      await Promise.resolve()
    })
    const suggestion = renderer!.root.findAll(
      (node) => node.type === 'Pressable' && !node.props.accessibilityLabel
    )[0] as { props: { onPress: () => void } }
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
