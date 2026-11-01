// @vitest-environment happy-dom
import { createElement, useRef, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { TextInput } from 'react-native'
import { useMobileTerminalComposerImagePaste } from './use-mobile-terminal-composer-image-paste.web'

function Harness(props: {
  field: HTMLTextAreaElement
  onImagePaste: (mode?: 'image') => Promise<void>
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
    let mode: 'image' | undefined
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        createElement(Harness, {
          field,
          onImagePaste: (next) => {
            mode = next
            return paste
          },
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
    expect(mode).toBe('image')
    await act(async () => {
      release()
      await paste
    })
    expect(pending).toBe(false)
    renderer.unmount()
    field.remove()
  })

  it('clears pending when the clipboard image read rejects', async () => {
    const field = document.createElement('textarea')
    document.body.append(field)
    let pending = false
    let mode: 'image' | undefined
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        createElement(Harness, {
          field,
          onImagePaste: async (next) => {
            mode = next
          },
          readClipboardImage: async () => {
            throw new Error('clipboard read failed')
          },
          onPending: (next) => {
            pending = next
          }
        })
      )
    })
    await act(async () => {
      field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true }))
    })
    expect(pending).toBe(false)
    expect(mode).toBe('image')
    renderer.unmount()
    field.remove()
  })
})
