// @vitest-environment happy-dom
import { act, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type * as ReactNative from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import { MobileNativeChatLowerRegion } from '../MobileNativeChatLowerRegion.web'

vi.mock('react-native', () => vi.importActual<typeof ReactNative>('react-native-web'))
vi.mock(
  './MobileNativeChatComposerAllocation',
  () => import('./MobileNativeChatComposerAllocation.web')
)
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
vi.mock('./MobileNativeChatSendButton', () => ({
  MobileNativeChatSendButton: () => null,
  MobileNativeChatSteerPreviewButton: (props: { preview: string; onPress: () => void }) => (
    <button type="button" data-preview={props.preview} onClick={props.onPress} />
  )
}))
vi.mock(
  './use-mobile-native-chat-steer-chord-preview',
  () => import('./use-mobile-native-chat-steer-chord-preview.web')
)
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

  it('resets the lower reading position on a chat switch while keeping the focused field', async () => {
    const renderSurface = (scopeKey: string) =>
      root.render(
        <MobileNativeChatLowerRegion scopeKey={scopeKey}>
          <textarea defaultValue="retained draft" />
        </MobileNativeChatLowerRegion>
      )
    await act(async () => renderSurface('chat-a'))
    const viewport = container.querySelector<HTMLElement>(
      '[data-testid="native-chat-lower-scroll"]'
    )!
    const input = field()
    Object.defineProperties(viewport, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 350 }
    })
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 0, 300, 100)
    )
    vi.spyOn(input, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 320 - viewport.scrollTop, 300, 30)
    )
    await act(async () => {
      input.focus()
      window.dispatchEvent(new Event('resize'))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    expect(viewport.scrollTop).toBe(250)
    await act(async () => {
      viewport.scrollTop = 140
      viewport.dispatchEvent(new Event('scroll'))
      viewport.dispatchEvent(new Event('scrollend'))
    })
    await act(async () => renderSurface('chat-b'))
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(viewport.scrollTop).toBe(250)
    expect(field()).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('retained draft')
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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
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

  it('keeps suggestions with their focused composer, including keyboard focus inside its popup', async () => {
    queuedGeometry()
    let openQueue!: () => void
    let typeQueuedTrigger!: () => void
    const save = vi.fn().mockResolvedValue(true)
    function Drafts() {
      const [normal, setNormal] = useState('@rea')
      const [queued, setQueued] = useState('')
      const [editing, setEditing] = useState(false)
      openQueue = () => setEditing(true)
      typeQueuedTrigger = () => setQueued('@que')
      return (
        <>
          <MobileNativeChatComposer
            sendSurfaceId="normal-test"
            getSendCompletionGeneration={() => 0}
            getComposerEditGeneration={() => 0}
            value={normal}
            onChangeText={setNormal}
            onSend={onSend}
            filePaths={['README.md']}
          />
          {editing ? (
            <MobileNativeChatComposer
              sendSurfaceId="queued-test"
              getSendCompletionGeneration={() => 0}
              getComposerEditGeneration={() => 0}
              value={queued}
              onChangeText={setQueued}
              onSend={save}
              filePaths={['queue.ts']}
              editSession={{ cancel: vi.fn(), refuseCommand: () => false, locked: false }}
            />
          ) : null}
          <button data-testid="outside-composers">Outside the composers</button>
        </>
      )
    }
    await act(async () => root.render(<Drafts />))
    const normal = field()
    await act(async () => normal.focus())
    await selectEnd()
    expect(suggestion()).not.toBeNull()
    await act(async () => openQueue())
    const queued = container.querySelectorAll('textarea')[1]!
    await act(async () => queued.focus())
    expect(suggestion()).toBeNull()
    await act(async () => typeQueuedTrigger())
    await act(async () => {
      queued.setSelectionRange(4, 4)
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
      queued.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
    })
    const row = container.querySelector<HTMLElement>('[aria-label="queue.ts"]')!
    expect(row).not.toBeNull()
    expect(suggestion()).toBeNull()
    await act(async () => row.focus())
    expect(document.activeElement).toBe(row)
    expect(row.isConnected).toBe(true)
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      row.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
      // happy-dom does not synthesize the browser's native button click for Enter.
      row.click()
    })
    expect(queued.value).toBe('@queue.ts ')
    expect(normal.value).toBe('@rea')
    expect(document.activeElement).toBe(queued)
    expect(queued.selectionStart).toBe(10)
    expect(onSend).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    await act(async () => normal.focus())
    expect(suggestion()).not.toBeNull()
    await act(async () =>
      container.querySelector<HTMLElement>('[data-testid="outside-composers"]')!.focus()
    )
    expect(suggestion()).toBeNull()
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(suggestion()).toBeNull()
    expect(container.querySelector('[aria-label="queue.ts"]')).toBeNull()
  })

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
