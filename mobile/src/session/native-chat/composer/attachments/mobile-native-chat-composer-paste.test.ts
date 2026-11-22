import { expect, it, vi } from 'vitest'
import { mobileNativeChatComposerPasteHandler } from './mobile-native-chat-composer-paste'

it('leaves a link copied without plain text to the field', () => {
  // iOS WebKit's event for a share-sheet link copy (public.url only), seen on an iOS 27 simulator.
  const event = {
    defaultPrevented: false,
    preventDefault: vi.fn(),
    clipboardData: {
      items: [{ type: 'text/uri-list', getAsFile: (): File | null => null }],
      files: [],
      getData: (format: string) => (format === 'text/uri-list' ? 'https://example.com/a?b=1' : '')
    }
  }
  const onPasteImages = vi.fn()
  mobileNativeChatComposerPasteHandler({
    disabled: false,
    onPasteImages,
    onAttachPastedText: vi.fn()
  })(event)
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(onPasteImages).not.toHaveBeenCalled()
})
