import { createElement, type ComponentProps } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatComposer as NativeChatComposer } from './native-chat/composer/MobileNativeChatComposer'

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
    Platform: { OS: 'ios' },
    Image: 'Image',
    Keyboard: { dismiss: vi.fn() },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: React.ReactNode }) =>
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
  AtSign: 'AtSign',
  Image: 'Image',
  Paperclip: 'Paperclip',
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

const structured = (
  overrides: Partial<NonNullable<ComponentProps<typeof NativeChatComposer>['structured']>> = {}
) => ({
  catalog: {
    reported: [
      { name: 'compact', kind: 'command' as const },
      { name: 'review-pr', kind: 'skill' as const, description: 'Review a pull request' }
    ],
    conversationCommands: []
  },
  onSlashMenuOpen: vi.fn(),
  files: [],
  onRemoveFile: vi.fn(),
  ...overrides
})

describe('MobileNativeChatComposer on a structured chat', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  const draw = (props: Partial<ComponentProps<typeof MobileNativeChatComposer>>) =>
    createElement(MobileNativeChatComposer, {
      value: '',
      onChangeText: vi.fn(),
      onSend: vi.fn().mockResolvedValue(true),
      sendSurfaceId: 'tab-a',
      getSendCompletionGeneration: () => 0,
      agent: 'claude',
      ...props
    })
  const field = () => renderer!.root.find((node) => node.props.multiline === true)
  const labelled = (label: string) =>
    renderer!.root.findAll(
      (node) => node.props.accessibilityLabel === label && node.props.onPress !== undefined
    )
  const drawers = () => renderer!.root.findAll((node) => node.props.onHidden !== undefined)

  it('puts a picked skill at the start of the draft, highlighted, and deletes it as one unit', async () => {
    const onChangeText = vi.fn()
    const catalog = structured()
    await act(async () => {
      renderer = create(draw({ value: '/re', onChangeText, structured: catalog }))
    })
    await act(async () =>
      field().props.onSelectionChange({ nativeEvent: { selection: { end: 3 } } })
    )
    expect(catalog.onSlashMenuOpen).toHaveBeenCalled()
    await act(async () => labelled('/review-pr')[0]!.props.onPress())
    expect(onChangeText).toHaveBeenLastCalledWith('/review-pr ')
    expect(field().props.selection).toEqual({ start: 11, end: 11 })

    await act(async () =>
      renderer!.update(draw({ value: '/review-pr focus', onChangeText, structured: catalog }))
    )
    const token = field().find((node) => node.props.children === '/review-pr')
    expect(token.props.style).toMatchObject({ backgroundColor: expect.any(String) })
    await act(async () => field().props.onChangeText('/review-pr focus on auth'))
    expect(onChangeText).toHaveBeenLastCalledWith('/review-pr focus on auth')
    await act(async () => field().props.onChangeText('/review-prfocus'))
    expect(onChangeText).toHaveBeenLastCalledWith('focus')
  })

  it('opens the + sheet on a structured chat, and the photo library at once otherwise', async () => {
    const onAttachImage = vi.fn()
    await act(async () => {
      renderer = create(draw({ onAttachImage, structured: structured() }))
    })
    await act(async () => labelled('Add to message')[0]!.props.onPress())
    expect(onAttachImage).not.toHaveBeenCalled()
    expect(drawers()).toHaveLength(1)

    await act(async () => renderer!.update(draw({ onAttachImage, structured: null })))
    await act(async () => labelled('Attach image')[0]!.props.onPress())
    expect(onAttachImage).toHaveBeenCalledTimes(1)
  })

  it('holds Send while a file is still uploading, and sends a stored file alone', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const file = { id: 'f1', name: 'spec.pdf', mime: 'application/pdf', byteLength: 10 }
    await act(async () => {
      renderer = create(
        draw({
          value: 'see attached',
          onSend,
          structured: structured({ files: [{ ...file, path: null }] })
        })
      )
    })
    expect(labelled('Send message')[0]!.props.disabled).toBe(true)
    await act(async () => labelled('Send message')[0]!.props.onPress())
    expect(onSend).not.toHaveBeenCalled()
    await act(async () =>
      renderer!.update(
        draw({ onSend, structured: structured({ files: [{ ...file, path: '/s/spec.pdf' }] }) })
      )
    )
    expect(labelled('Send message')[0]!.props.disabled).toBe(false)
    await act(async () => labelled('Send message')[0]!.props.onPress())
    expect(onSend).toHaveBeenCalledExactlyOnceWith('')
  })
})

// The setup-only editing lock leaves ordinary transient-lock drafting and Stop intact.
describe('workspace setup editing availability', () => {
  let view: ReactTestRenderer | null = null
  afterEach(() =>
    act(() => {
      view?.unmount()
      view = null
    })
  )
  it.each([true, false])(
    'blocks actual editing and Send for structured=%s, keeping Stop with a draft',
    async (isStructured) => {
      const onSend = vi.fn(async () => true)
      const onChangeText = vi.fn()
      const onStop = vi.fn()
      const onMicPress = vi.fn()
      const props = {
        value: 'retained draft',
        onSend,
        onChangeText,
        onMicPress,
        onAttachImage: vi.fn(),
        sendSurfaceId: 'setup-chat',
        getSendCompletionGeneration: () => 0,
        structured: isStructured ? structured() : null
      }
      await act(async () => {
        view = create(createElement(MobileNativeChatComposer, props))
      })
      const send = view!.root.find(
        (node) =>
          String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Send message'
      ).props.onPress
      await act(async () => {
        view!.update(
          createElement(MobileNativeChatComposer, {
            ...props,
            setupAgentStartHeld: true,
            stop: { held: false, onStop }
          })
        )
      })
      const field = view!.root.find((node) => String(node.type) === 'TextInput')
      expect(field.props.editable).toBe(false)
      expect(field.props.value).toBe('retained draft')
      await act(async () => {
        field.props.onChangeText('no')
        await send()
      })
      expect(onChangeText).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      const stop = view!.root.find(
        (node) =>
          String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Stop the agent'
      )
      expect(stop.props.disabled).toBe(false)
      await act(async () => stop.props.onPress())
      expect(onStop).toHaveBeenCalledOnce()
      const mic = view!.root.find(
        (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Dictate'
      )
      await act(async () => mic.props.onPress())
      expect(onMicPress).not.toHaveBeenCalled()
      await act(async () => {
        view!.update(createElement(MobileNativeChatComposer, { ...props, disabled: true }))
      })
      expect(view!.root.find((node) => String(node.type) === 'TextInput').props.editable).toBe(true)
      await act(async () => {
        view!.update(createElement(MobileNativeChatComposer, props))
      })
      expect(
        view!.root.find(
          (node) =>
            String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Send message'
        ).props.disabled
      ).toBe(false)
    }
  )
})
