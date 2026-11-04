// @vitest-environment happy-dom
import { act, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'

vi.mock('react-native', () => vi.importActual<typeof import('react-native')>('react-native-web'))
vi.mock('./MobileNativeChatComposerField', () => import('./MobileNativeChatComposerField.web'))
vi.mock('../../../platform/host-os', () => import('../../../platform/host-os.web'))
vi.mock('../../../platform/keyboard-occlusion', () => ({ useKeyboardOcclusion: () => 0 }))
vi.mock('lucide-react-native', () => ({ Plus: () => null }))
vi.mock('../../../components/ActionSheetModal', () => ({ ActionSheetModal: () => null }))
vi.mock('../input/MobileNativeChatSessionOptionPickers', () => ({
  MobileNativeChatSessionOptionPickers: () => null
}))
vi.mock('./MobileNativeChatComposerMic', () => ({ MobileNativeChatComposerMic: () => null }))
vi.mock('./MobileNativeChatSendButton', () => ({ MobileNativeChatSendButton: () => null }))
vi.mock('./MobileNativeChatEditActions', () => ({ MobileNativeChatEditActions: () => null }))
vi.mock('./MobileNativeChatComposerAttachments', () => ({
  MobileNativeChatComposerAttachments: () => null
}))
vi.mock('./MobileNativeChatComposerMenu', () => ({ MobileNativeChatComposerMenu: () => null }))

type ComposerProps = ComponentProps<typeof MobileNativeChatComposer>

describe('mobile composer modifier submit in the paired web page', () => {
  let root: Root
  let container: HTMLDivElement
  const onSend = vi.fn<ComposerProps['onSend']>()

  beforeEach(() => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPad')
    onSend.mockReset().mockResolvedValue(true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  function field(): HTMLTextAreaElement {
    const input = container.querySelector('textarea')
    if (!input) {
      throw new Error('Composer field missing')
    }
    return input
  }

  async function render(props: Partial<ComposerProps> = {}) {
    function Draft() {
      const [value, setValue] = useState(props.value ?? ' hello ')
      return (
        <MobileNativeChatComposer
          sendSurfaceId="keyboard-test"
          getSendCompletionGeneration={() => 0}
          getComposerEditGeneration={() => 0}
          {...props}
          value={value}
          onChangeText={setValue}
          onSend={onSend}
        />
      )
    }
    await act(async () => root.render(<Draft />))
    await act(async () => field().focus())
  }

  async function key(flags: KeyboardEventInit = {}) {
    // Enter's base shape was captured in the native iOS shell; modifier flags are supplied, not recorded chords.
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      bubbles: true,
      cancelable: true,
      ...flags
    })
    await act(async () => {
      field().dispatchEvent(event)
    })
    return event
  }

  async function selectEnd() {
    await act(async () => {
      const input = field()
      input.setSelectionRange(input.value.length, input.value.length)
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
    })
  }

  it.each([true, false])(
    'sends raw text with alternate intent, retaining focus on accepted:%s',
    async (accepted) => {
      onSend.mockResolvedValue(accepted)
      await render()
      expect((await key({ metaKey: true })).defaultPrevented).toBe(true)
      expect(onSend).toHaveBeenCalledExactlyOnceWith(' hello ', { alternate: true })
      expect(document.activeElement).toBe(field())
      expect(field().value).toBe(' hello ')
    }
  )

  it('uses Ctrl on Android and leaves Cmd alone', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android')
    await render()
    expect((await key({ metaKey: true })).defaultPrevented).toBe(false)
    expect(onSend).not.toHaveBeenCalled()
    expect((await key({ ctrlKey: true })).defaultPrevented).toBe(true)
    expect(onSend).toHaveBeenCalledExactlyOnceWith(' hello ', { alternate: true })
  })

  it.each([
    {},
    { shiftKey: true },
    { ctrlKey: true },
    { metaKey: true, shiftKey: true },
    { metaKey: true, altKey: true },
    { metaKey: true, ctrlKey: true },
    { metaKey: true, isComposing: true },
    { metaKey: true, keyCode: 229 }
  ])('leaves editing and composition keys untouched: %j', async (flags) => {
    await render()
    expect((await key(flags)).defaultPrevented).toBe(false)
    expect(onSend).not.toHaveBeenCalled()
    expect(field().value).toBe(' hello ')
  })

  it('consumes a refused send without changing the draft or focus', async () => {
    await render({ sendDisabled: true })
    expect((await key({ metaKey: true })).defaultPrevented).toBe(true)
    expect(onSend).not.toHaveBeenCalled()
    expect(field().value).toBe(' hello ')
    expect(document.activeElement).toBe(field())
  })

  it('saves a queued edit without alternate intent', async () => {
    await render({ editSession: { cancel: vi.fn(), refuseCommand: () => false, locked: false } })
    expect((await key({ metaKey: true })).defaultPrevented).toBe(true)
    expect(onSend).toHaveBeenCalledExactlyOnceWith(' hello ')
    expect(document.activeElement).toBe(field())
  })

  it.each([
    { value: '@rea', expected: '@README.md ', filePaths: ['README.md', 'src/read.ts'] },
    { value: '/comp', expected: '/compact ', filePaths: [] }
  ])(
    'completes the first existing menu row for $value without submitting',
    async ({ value, expected, filePaths }) => {
      await render({
        value,
        filePaths,
        agent: 'codex',
        structured: {
          catalog: { reported: [{ name: 'compact', kind: 'command' }], conversationCommands: [] },
          files: [],
          onRemoveFile: vi.fn(),
          onSlashMenuOpen: vi.fn()
        }
      })
      await selectEnd()
      expect((await key({ metaKey: true })).defaultPrevented).toBe(true)
      expect(field().value).toBe(expected)
      expect(onSend).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(field())
      expect((await key({ metaKey: true, repeat: true })).defaultPrevented).toBe(true)
      expect(onSend).not.toHaveBeenCalled()
      expect(field().value).toBe(expected)
    }
  )
})
