import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const hosts = vi.hoisted(() => {
  const Box = (props: { children?: ReactNode }): ReactNode => props.children ?? null
  Box.displayName = 'MessageBox'
  return { Box }
})
vi.mock('react-native', () => ({ Pressable: () => null }))
vi.mock('lucide-react-native', () => ({ X: () => null }))
vi.mock('../../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'light' }))
vi.mock('../composer-input/MessageBox', () => ({ MessageBox: hosts.Box }))
vi.mock('../composer-input/composer-input-styles', () => ({ composerInputStyles: {} }))

import { publishPageDeviceStore } from '../../mobile-web-shell/bridge/page-device-store'
import { resetDurableDraftFieldsForTests } from '../../drafts/durable-draft-fields'
import { publishInMemoryDeviceStore } from '../../drafts/in-memory-device-store.test-support'
import { PRCommentComposer } from './PRCommentComposer'

// The shell's draft table outlives the page; nothing else does.
const table = new Map<string, string>()
let renderer: ReactTestRenderer | null = null
let onSubmit: (body: string) => Promise<boolean> = async () => true

const KEY = 'draft:prComment:wt-1:host-1::/acme/app#12#new'

async function open(): Promise<void> {
  await act(async () => {
    renderer = create(
      createElement(PRCommentComposer, {
        placeholder: 'Comment',
        submitLabel: 'Comment',
        submitting: false,
        draftKey: KEY,
        onSubmit: (body: string) => onSubmit(body)
      })
    )
    await vi.advanceTimersByTimeAsync(0)
  })
}

function box(): { value: string; onChangeText: (text: string) => void; onSend: () => void } {
  const props = renderer?.root.findByType(hosts.Box).props
  return { value: props?.value, onChangeText: props?.onChangeText, onSend: props?.onSend }
}

async function type(text: string): Promise<void> {
  act(() => box().onChangeText(text))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
}

// A kill: the page and its memory go, the store stays.
function kill(): void {
  act(() => renderer?.unmount())
  renderer = null
  resetDurableDraftFieldsForTests()
}

beforeEach(() => {
  vi.useFakeTimers()
  publishInMemoryDeviceStore(table)
})

afterEach(() => {
  kill()
  table.clear()
  publishPageDeviceStore(null)
  onSubmit = async () => true
  vi.useRealTimers()
})

it('keeps text typed in a reopened composer when the earlier post lands', async () => {
  let land: (ok: boolean) => void = () => {}
  onSubmit = () => new Promise((resolve) => (land = resolve))
  await open()
  await type('first thought')
  act(() => box().onSend())
  act(() => renderer?.unmount())

  await open()
  await type('a second thought')
  await act(async () => {
    land(true)
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(box().value).toBe('a second thought')
})
