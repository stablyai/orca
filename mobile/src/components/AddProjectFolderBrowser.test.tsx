import { createElement } from 'react'
import { Text } from 'react-native'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock(
  'lucide-react-native',
  () =>
    new Proxy(
      {},
      { get: (_target, name) => (typeof name === 'string' ? name : undefined), has: () => true }
    )
)
vi.mock('./new-worktree-form-styles', () => ({ newWorktreeFormStyles: {} }))

import { AddProjectFolderBrowser } from './AddProjectFolderBrowser'

function listing(
  resolvedPath: string,
  entries: { name: string; isDirectory: boolean; isSymlink: boolean }[]
) {
  return { ok: true, result: { resolvedPath, entries }, _meta: { runtimeId: 'r' } }
}

function clientWith(sendRequest: RpcClient['sendRequest']): RpcClient {
  return { ...createFakeRpcClient(), sendRequest }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function button(tree: ReactTestRenderer, label: string): ReactTestInstance {
  return tree.root.find((node) => node.props.accessibilityLabel === label)
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('AddProjectFolderBrowser', () => {
  let renderer: ReactTestRenderer | undefined

  afterEach(() => {
    act(() => renderer?.unmount())
  })

  it('shows, enters, and picks a directory symlink while hiding normal files', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(
        listing('/home/dev', [
          { name: 'linked-repo', isDirectory: false, isSymlink: true },
          { name: 'notes.txt', isDirectory: false, isSymlink: false }
        ])
      )
      .mockResolvedValueOnce(listing('/home/dev/linked-repo', []))
    const onPick = vi.fn()
    act(() => {
      renderer = create(
        createElement(AddProjectFolderBrowser, {
          client: clientWith(sendRequest),
          busy: false,
          error: '',
          onBack: vi.fn(),
          onPick
        })
      )
    })
    await settle()
    expect(button(renderer!, 'linked-repo')).toBeDefined()
    expect(() => button(renderer!, 'notes.txt')).toThrow()
    act(() => button(renderer!, 'linked-repo').props.onPress())
    await settle()
    expect(sendRequest).toHaveBeenLastCalledWith('files.browseServerDir', {
      path: '/home/dev/linked-repo'
    })
    act(() => button(renderer!, 'Add this folder as a project').props.onPress())
    expect(onPick).toHaveBeenCalledWith('/home/dev/linked-repo')
  })

  it('keeps the prior listing when a file or broken symlink refuses to open', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce(
        listing('/home/dev', [
          { name: 'broken-link', isDirectory: false, isSymlink: true },
          { name: 'file-link', isDirectory: false, isSymlink: true }
        ])
      )
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'not_directory', message: 'Not a folder' }
      })
    const onPick = vi.fn()
    act(() => {
      renderer = create(
        createElement(AddProjectFolderBrowser, {
          client: clientWith(sendRequest),
          busy: false,
          error: '',
          onBack: vi.fn(),
          onPick
        })
      )
    })
    await settle()
    act(() => button(renderer!, 'broken-link').props.onPress())
    await settle()
    expect(button(renderer!, 'broken-link')).toBeDefined()
    expect(button(renderer!, 'Add this folder as a project').props.disabled).toBe(false)
    expect(
      renderer!.root.findAllByType(Text).some((node) => node.props.children === 'Not a folder')
    ).toBe(true)
    expect(onPick).not.toHaveBeenCalled()

    act(() =>
      renderer!.update(
        createElement(AddProjectFolderBrowser, {
          client: clientWith(sendRequest),
          busy: true,
          error: '',
          onBack: vi.fn(),
          onPick
        })
      )
    )
    expect(button(renderer!, 'Add this folder as a project').props.disabled).toBe(true)
  })

  it('ignores stale replies and rejects while switching clients, and disables picking while loading', async () => {
    const firstRequest = deferred<ReturnType<typeof listing>>()
    const secondRequest = deferred<ReturnType<typeof listing>>()
    const thirdRequest = deferred<ReturnType<typeof listing>>()
    const fourthRequest = deferred<ReturnType<typeof listing>>()
    const firstClient = clientWith(vi.fn().mockReturnValue(firstRequest.promise))
    const secondClient = clientWith(vi.fn().mockReturnValue(secondRequest.promise))
    const thirdClient = clientWith(vi.fn().mockReturnValue(thirdRequest.promise))
    const fourthClient = clientWith(vi.fn().mockReturnValue(fourthRequest.promise))
    const onPick = vi.fn()

    act(() => {
      renderer = create(
        createElement(AddProjectFolderBrowser, {
          client: firstClient,
          busy: false,
          error: '',
          onBack: vi.fn(),
          onPick
        })
      )
    })
    expect(button(renderer!, 'Add this folder as a project').props.disabled).toBe(true)

    act(() => {
      renderer!.update(
        createElement(AddProjectFolderBrowser, {
          client: secondClient,
          busy: false,
          error: '',
          onBack: vi.fn(),
          onPick
        })
      )
    })
    secondRequest.resolve(listing('/second', []))
    await settle()
    expect(button(renderer!, 'Add this folder as a project').props.disabled).toBe(false)
    expect(button(renderer!, 'Add this folder as a project').props.onPress).toBeDefined()

    firstRequest.resolve(listing('/stale', []))
    await settle()
    expect(button(renderer!, 'Add this folder as a project').props.disabled).toBe(false)
    expect(
      renderer!.root.findAllByType(Text).some((node) => node.props.children === '/second')
    ).toBe(true)
    act(() =>
      renderer!.update(
        createElement(AddProjectFolderBrowser, {
          client: thirdClient,
          busy: false,
          error: '',
          onBack: vi.fn(),
          onPick
        })
      )
    )
    act(() =>
      renderer!.update(
        createElement(AddProjectFolderBrowser, {
          client: fourthClient,
          busy: false,
          error: '',
          onBack: vi.fn(),
          onPick
        })
      )
    )
    fourthRequest.resolve(listing('/fourth', []))
    await settle()
    thirdRequest.reject(new Error('stale connection'))
    await settle()
    expect(button(renderer!, 'Add this folder as a project').props.disabled).toBe(false)
    expect(
      renderer!.root.findAllByType(Text).some((node) => node.props.children === 'stale connection')
    ).toBe(false)

    act(() => button(renderer!, 'Add this folder as a project').props.onPress())
    expect(onPick).toHaveBeenCalledWith('/fourth')
  })
})
