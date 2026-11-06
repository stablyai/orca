// @vitest-environment happy-dom
import { act, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type * as ReactNative from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'

vi.mock('react-native', () => vi.importActual<typeof ReactNative>('react-native-web'))
vi.mock('./MobileNativeChatComposerField', () => import('./MobileNativeChatComposerField.web'))
vi.mock('../../../platform/host-os', () => import('../../../platform/host-os.web'))
vi.mock('../../../platform/keyboard-occlusion', () => ({ useKeyboardOcclusion: () => 0 }))
vi.mock('lucide-react-native', () => ({
  Plus: () => null,
  AtSign: () => null,
  Image: () => null,
  Package: () => null,
  Paperclip: () => null,
  FileText: () => null,
  Terminal: () => null
}))
vi.mock('../../../components/ActionSheetModal', () => ({ ActionSheetModal: () => null }))
vi.mock('../input/MobileNativeChatSessionOptionPickers', () => ({
  MobileNativeChatSessionOptionPickers: () => null
}))
vi.mock('./MobileNativeChatComposerMic', () => ({ MobileNativeChatComposerMic: () => null }))
vi.mock('./MobileNativeChatContextUsageRing', () => ({
  useMobileNativeChatContextRing: () => ({ barProps: {}, ring: null })
}))
vi.mock('./MobileNativeChatSendButton', () => ({ MobileNativeChatSendButton: () => null }))
vi.mock('./MobileNativeChatEditActions', () => ({ MobileNativeChatEditActions: () => null }))
vi.mock('./MobileNativeChatComposerAttachments', () => ({
  MobileNativeChatComposerAttachments: () => null
}))
vi.mock(
  './MobileNativeChatComposerMenuLayer',
  () => import('./MobileNativeChatComposerMenuLayer.web')
)

type ComposerProps = ComponentProps<typeof MobileNativeChatComposer>

describe('mobile composer modifier submit in the paired web page', () => {
  let root: Root
  let container: HTMLDivElement
  const onSend = vi.fn<ComposerProps['onSend']>()

  beforeEach(() => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPad')
    onSend.mockReset().mockResolvedValue(true)
    container = document.createElement('div')
    container.setAttribute('data-testid', 'native-chat-view')
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
      const composer = (
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
      return props.editSession ? (
        <div data-testid="queue-viewport" style={{ overflow: 'hidden' }}>
          {composer}
        </div>
      ) : (
        composer
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

  function queuedGeometry() {
    const anchor = { top: 430, width: 390, clipTop: 250, clipHeight: 300 }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this === container) {
        return new DOMRect(0, 80, 390, 620)
      }
      if (this.getAttribute('data-testid') === 'queue-viewport') {
        return new DOMRect(0, anchor.clipTop, 390, anchor.clipHeight)
      }
      return new DOMRect(0, anchor.top, anchor.width, 100)
    })
    return anchor
  }

  async function queuedMention() {
    await render({
      value: '@rea',
      filePaths: ['README.md', 'src/read.ts'],
      agent: 'codex',
      editSession: { cancel: vi.fn(), refuseCommand: () => false, locked: false }
    })
    await selectEnd()
  }

  function suggestion() {
    return container.querySelector<HTMLElement>('[aria-label="README.md"]')
  }

  it('picks a suggestion outside the clipped queue while keeping the edited draft focused', async () => {
    queuedGeometry()
    await queuedMention()
    const input = field()
    const row = suggestion()
    expect(row).not.toBeNull()
    const queue = container.querySelector('[data-testid="queue-viewport"]')!
    expect(queue.contains(row)).toBe(false)
    expect(container.contains(row)).toBe(true)
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => {
      row!.dispatchEvent(down)
      row!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      row!.click()
    })
    expect(down.defaultPrevented).toBe(true)
    expect(field()).toBe(input)
    expect(input.value).toBe('@README.md ')
    expect(document.activeElement).toBe(input)
    expect(suggestion()).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('retires scrolled-out or hidden editor suggestions and restores them from current geometry', async () => {
    const anchor = queuedGeometry()
    await queuedMention()
    expect(
      suggestion(),
      JSON.stringify({
        value: field().value,
        caret: field().selectionStart,
        focused: document.activeElement === field(),
        viewport: window.innerHeight,
        text: container.textContent?.slice(0, 120)
      })
    ).not.toBeNull()
    anchor.top = 900
    await act(async () => window.dispatchEvent(new Event('scroll')))
    expect(suggestion()).toBeNull()
    anchor.top = 430
    await act(async () => window.dispatchEvent(new Event('scroll')))
    expect(suggestion()).not.toBeNull()
    anchor.clipTop = 450
    anchor.clipHeight = 0
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(suggestion()).toBeNull()
    anchor.clipTop = 250
    anchor.clipHeight = 300
    anchor.width = 0
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(suggestion()).toBeNull()
    expect(field().value).toBe('@rea')
    expect(document.activeElement).toBe(field())
  })
})
