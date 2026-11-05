// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type * as ReactNative from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'

vi.mock('react-native', () => vi.importActual<typeof ReactNative>('react-native-web'))
vi.mock('./MobileNativeChatComposerField', () => import('./MobileNativeChatComposerField.web'))
vi.mock('../../../platform/keyboard-occlusion', () => ({ useKeyboardOcclusion: () => 0 }))
vi.mock('lucide-react-native', () => ({
  Plus: () => null,
  AtSign: () => null,
  Image: () => null,
  Package: () => null,
  Paperclip: () => null,
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
vi.mock('./MobileNativeChatComposerMenu', () => ({ MobileNativeChatComposerMenu: () => null }))

type ComposerProps = ComponentProps<typeof MobileNativeChatComposer>

describe('pasting into the mobile composer in the paired web page', () => {
  let root: Root
  let container: HTMLDivElement
  const onPasteImages = vi.fn()
  const onAttachPastedText = vi.fn()

  beforeEach(() => {
    onPasteImages.mockReset()
    onAttachPastedText.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function render(props: Partial<ComposerProps> = {}) {
    await act(async () =>
      root.render(
        <MobileNativeChatComposer
          sendSurfaceId="paste-test"
          getSendCompletionGeneration={() => 0}
          getComposerEditGeneration={() => 0}
          value=""
          onChangeText={vi.fn()}
          onSend={vi.fn()}
          onPasteImages={onPasteImages}
          structured={{
            catalog: { reported: [], conversationCommands: [] },
            files: [],
            onRemoveFile: vi.fn(),
            onSlashMenuOpen: vi.fn(),
            onAttachPastedText
          }}
          {...props}
        />
      )
    )
  }

  function paste(text: string, image?: File): Event {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: image ? [{ type: image.type, getAsFile: () => image }] : [],
        files: image ? [image] : [],
        getData: (format: string) => (format === 'text/plain' ? text : '')
      }
    })
    const field = container.querySelector('textarea')
    if (!field) {
      throw new Error('Composer field missing')
    }
    field.dispatchEvent(event)
    return event
  }

  it('turns a 32 KB paste into a pasted-text file and leaves shorter text to the field', async () => {
    await render()
    const long = 'a'.repeat(32 * 1024)
    expect(paste(long).defaultPrevented).toBe(true)
    expect(onAttachPastedText).toHaveBeenCalledExactlyOnceWith(long)

    expect(paste(long.slice(1)).defaultPrevented).toBe(false)
    expect(onAttachPastedText).toHaveBeenCalledTimes(1)
    expect(onPasteImages).not.toHaveBeenCalled()
  })
})
