import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable' }))
vi.mock('../theme/mobile-theme', () => ({ pressedStyle: {} }))
vi.mock('./connection-diagnostics-screen-styles', () => ({ connectionDiagnosticsScreenStyles: {} }))

import { ConnectionIdCopy } from './connection-id-copy'

let tree: ReactTestRenderer | undefined

afterEach(async () => {
  if (tree) {
    await act(() => tree?.unmount())
  }
  tree = undefined
})

async function render(hostId: string | null, writeClipboard: (value: string) => Promise<unknown>) {
  await act(() => {
    tree = create(createElement(ConnectionIdCopy, { hostId, writeClipboard }))
  })
  return tree!
}

function button() {
  return tree!.root.findByProps({ testID: 'copy-connection-id' })
}

function text() {
  return JSON.stringify(tree!.toJSON())
}

it('copies the selected connection ID and confirms only after the clipboard write completes', async () => {
  const pending = Promise.withResolvers<void>()
  const write = vi.fn(() => pending.promise)
  await render('host-123', write)
  await act(() => button().props.onPress())
  expect(write).toHaveBeenCalledExactlyOnceWith('host-123')
  expect(button().props.disabled).toBe(true)
  expect(text()).not.toContain('Connection ID copied')
  await act(async () => pending.resolve())
  expect(text()).toContain('Connection ID copied')
})

it('allows retry after clipboard rejection without reporting success', async () => {
  const write = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
  await render('host-456', write)
  await act(async () => button().props.onPress())
  expect(text()).toContain('Could not copy. Try again.')
  expect(text()).not.toContain('Connection ID copied')
  expect(button().props.disabled).toBe(false)
  await act(async () => button().props.onPress())
  expect(text()).toContain('Connection ID copied')
  expect(write.mock.calls).toEqual([['host-456'], ['host-456']])
})

it('does not attribute an earlier pending write to a newly selected host', async () => {
  const pending = Promise.withResolvers<void>()
  const write = vi.fn((id: string) => (id === 'host-A' ? pending.promise : Promise.resolve()))
  const rendered = await render('host-A', write)
  await act(() => button().props.onPress())
  await act(() =>
    rendered.update(createElement(ConnectionIdCopy, { hostId: 'host-B', writeClipboard: write }))
  )
  await act(async () => pending.resolve())
  expect(text()).not.toContain('Connection ID copied')
  expect(text()).toContain('host-B')
  await act(async () => button().props.onPress())
  expect(write.mock.calls).toEqual([['host-A'], ['host-B']])
})
