import { describe, expect, it, vi } from 'vitest'
import { handleMobileNativeChatComposerPaste } from './mobile-native-chat-composer-paste'

function pasteEvent(text: string, imageType?: string) {
  const file = imageType ? new File([], 'image.png', { type: imageType }) : null
  const event = {
    defaultPrevented: false,
    preventDefault: vi.fn(() => {
      event.defaultPrevented = true
    }),
    clipboardData: {
      items: file ? [{ type: file.type, getAsFile: () => file }] : [],
      files: file ? [file] : [],
      getData: (format: string) => (format === 'text/plain' ? text : '')
    }
  }
  return event
}

function targets(acceptsFiles = true) {
  return {
    attachImages: vi.fn(),
    attachPastedText: acceptsFiles ? vi.fn() : null,
    clipboard: { readImage: vi.fn(), contents: vi.fn() }
  }
}

describe('handleMobileNativeChatComposerPaste', () => {
  it('turns a 32 KB paste into a pasted-text file and leaves shorter text to the field', () => {
    const long = 'a'.repeat(32 * 1024)
    const longPaste = pasteEvent(long)
    const longTargets = targets()
    handleMobileNativeChatComposerPaste(longPaste, longTargets)
    expect(longPaste.defaultPrevented).toBe(true)
    expect(longTargets.attachPastedText).toHaveBeenCalledWith(long)

    const shortPaste = pasteEvent(long.slice(1))
    const shortTargets = targets()
    handleMobileNativeChatComposerPaste(shortPaste, shortTargets)
    expect(shortPaste.defaultPrevented).toBe(false)
    expect(shortTargets.attachPastedText).not.toHaveBeenCalled()
    expect(shortTargets.attachImages).not.toHaveBeenCalled()
  })

  it('keeps a long paste as text when the host stores no phone files', () => {
    const paste = pasteEvent('a'.repeat(40 * 1024))
    handleMobileNativeChatComposerPaste(paste, targets(false))
    expect(paste.defaultPrevented).toBe(false)
  })

  it('attaches a pasted image and leaves its caption to the field', () => {
    const paste = pasteEvent('a caption', 'image/png')
    const pasteTargets = targets()
    handleMobileNativeChatComposerPaste(paste, pasteTargets)
    expect(pasteTargets.attachImages).toHaveBeenCalledTimes(1)
    expect(paste.defaultPrevented).toBe(false)
  })

  it('reads the pasteboard when Paste brought neither text nor image bytes', () => {
    const paste = pasteEvent('')
    const pasteTargets = targets()
    handleMobileNativeChatComposerPaste(paste, pasteTargets)
    expect(paste.defaultPrevented).toBe(true)
    expect(pasteTargets.attachImages).toHaveBeenCalledTimes(1)
  })
})
