// @vitest-environment happy-dom
import { createElement, useRef, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { TextInput } from 'react-native'
import { useMobileTerminalComposerImagePaste } from './use-mobile-terminal-composer-image-paste.web'

function Harness(props: {
  field: HTMLTextAreaElement
  onImagePaste: () => Promise<void>
  readClipboardImage: () => Promise<{ base64: string } | null>
  onPending: (pending: boolean) => void
}) {
  const ref = useRef<TextInput | null>(props.field as unknown as TextInput)
  const pending = useMobileTerminalComposerImagePaste({
    enabled: true,
    fieldRefs: [ref as RefObject<TextInput | null>],
    onImagePaste: props.onImagePaste,
    readClipboardImage: props.readClipboardImage
  })
  props.onPending(pending)
  return null
}

describe('useMobileTerminalComposerImagePaste', () => {
  it('keeps command paste pending until the file paste finishes', async () => {
    const field = document.createElement('textarea')
    document.body.append(field)
    let release = (): void => {}
    const paste = new Promise<void>((resolve) => {
      release = resolve
    })
    let pending = false
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        createElement(Harness, {
          field,
          onImagePaste: () => paste,
          readClipboardImage: async () => null,
          onPending: (next) => {
            pending = next
          }
        })
      )
    })
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array([1])], '', { type: 'image/png' }))
    await act(async () => {
      field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }))
    })
    expect(pending).toBe(true)
    await act(async () => {
      release()
      await paste
    })
    expect(pending).toBe(false)
    renderer.unmount()
    field.remove()
  })
})
