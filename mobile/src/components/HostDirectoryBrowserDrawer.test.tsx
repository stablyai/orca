import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { HostDirectoryBrowserDrawer } from './HostDirectoryBrowserDrawer'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T): T => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock(
  'lucide-react-native',
  () =>
    new Proxy(
      {},
      {
        get: (_target, name) => (typeof name === 'string' ? name : undefined),
        has: () => true
      }
    )
)

vi.mock('./BottomDrawer', () => ({
  BottomDrawer: ({ children }: { children: unknown }) => children
}))

function getAddButton(renderer: ReactTestRenderer) {
  return renderer.root
    .findAll(
      (n) =>
        n.type === 'Pressable' && n.findAll((c) => c.props.children === 'Add project').length > 0
    )[0]
}

describe('HostDirectoryBrowserDrawer', () => {
  it('disables Add project while directory navigation is in-flight', async () => {
    let resolveBrowse: ((val: unknown) => void) | undefined
    const browsePromise = new Promise((resolve) => {
      resolveBrowse = resolve
    })

    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'files.browseServerDir') {
        return browsePromise
      }
      return { ok: true, result: {} }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test harness mock satisfying RpcClient sendRequest.
    const client = { sendRequest } as unknown as RpcClient
    const onAdded = vi.fn()

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        createElement(HostDirectoryBrowserDrawer, {
          visible: true,
          client,
          onClose: () => {},
          onAdded
        })
      )
    })

    let addBtn = getAddButton(renderer)
    expect(addBtn?.props.disabled).toBe(true)

    await act(async () => {
      resolveBrowse?.({
        ok: true,
        result: {
          resolvedPath: '/Users/alice/projects',
          entries: [{ name: 'subdir', isDirectory: true }],
          pathFlavor: 'posix'
        }
      })
      await Promise.resolve()
    })

    addBtn = getAddButton(renderer)
    expect(addBtn?.props.disabled).toBe(false)

    let resolveSecondBrowse: ((val: unknown) => void) | undefined
    const secondBrowsePromise = new Promise((resolve) => {
      resolveSecondBrowse = resolve
    })
    sendRequest.mockImplementation(async (method: string) => {
      if (method === 'files.browseServerDir') {
        return secondBrowsePromise
      }
      if (method === 'repo.add') {
        return {
          ok: true,
          result: {
            repo: {
              id: 'r1',
              displayName: 'subdir',
              path: '/Users/alice/projects/subdir',
              kind: 'git'
            }
          }
        }
      }
      return { ok: true, result: {} }
    })

    const textInput = renderer.root.findByType('TextInput')
    act(() => {
      textInput.props.onChangeText('/Users/alice/projects/subdir')
    })
    act(() => {
      textInput.props.onSubmitEditing()
    })

    addBtn = getAddButton(renderer)
    expect(addBtn?.props.disabled).toBe(true)

    act(() => {
      addBtn?.props.onPress()
    })
    expect(sendRequest).not.toHaveBeenCalledWith('repo.add', expect.anything())

    await act(async () => {
      resolveSecondBrowse?.({
        ok: true,
        result: {
          resolvedPath: '/Users/alice/projects/subdir',
          entries: [],
          pathFlavor: 'posix'
        }
      })
      await Promise.resolve()
    })

    addBtn = getAddButton(renderer)
    expect(addBtn?.props.disabled).toBe(false)

    await act(async () => {
      addBtn?.props.onPress()
    })
    expect(sendRequest).toHaveBeenCalledWith('repo.add', {
      path: '/Users/alice/projects/subdir',
      kind: 'git'
    })
    expect(onAdded).toHaveBeenCalled()
  })
})
