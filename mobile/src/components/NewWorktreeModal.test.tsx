import { createElement, Suspense, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn().mockResolvedValue(null),
  setItem: vi.fn().mockResolvedValue(undefined),
  removeItem: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./DisclosureChevron', () => ({
  DisclosureChevron: ({ children }: { children: unknown }) => children
}))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: { currentState: 'active' },
  FlatList: 'FlatList',
  Image: 'Image',
  Keyboard: { dismiss: vi.fn() },
  Linking: { openURL: vi.fn() },
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
// Every icon in the drawer tree renders as a host element named after itself.
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
vi.mock('./bottom-drawer/BottomDrawer', () => ({ BottomDrawer: 'BottomDrawer' }))
vi.mock('./bottom-drawer/bottom-drawer-modal-host', () => ({
  BottomDrawerModalHost: 'BottomDrawerModalHost'
}))
vi.mock('./PickerListDrawer', () => ({ PickerListDrawer: 'PickerListDrawer' }))
vi.mock('./AutoHeight', () => ({ AutoHeight: 'AutoHeight' }))
vi.mock('./MobileSwitch', () => ({ MobileSwitch: 'MobileSwitch' }))
vi.mock('./MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))
vi.mock('./TaskProviderLogo', () => ({ TaskProviderLogo: 'TaskProviderLogo' }))

// The form seeds from the host list's repo.list rows in this document's query cache.
const cachedRepos = new Map<string, unknown[]>()
const setCachedRepos = (hostId: string, rows: unknown[]) => cachedRepos.set(hostId, rows)
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => null }))
vi.mock('../host-screen/host-list-queries', () => ({
  cachedHostRepos: (_queryClient: unknown, hostId: string | undefined) =>
    (hostId && cachedRepos.get(hostId)) || null
}))

import '../transport/hosts/host-descriptor-store'
import { FakeSession } from '../transport/connection/mobile-endpoint-supervisor-test-fakes'
import '../../../src/shared/execution-host'
import type { ExecutionHostId } from '../../../src/shared/execution-host'

import { NewWorktreeModal } from './NewWorktreeModal'

import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

const repos = [
  {
    id: 'repo-1',
    displayName: 'orca',
    path: '/src/orca',
    kind: 'git',
    upstream: { owner: 'stablyai', repo: 'orca' }
  }
]

function pickerItems(
  renderer: ReactTestRenderer,
  title: string
): { label: string; detail: string }[] {
  const pickers = findAllByHostType(renderer.root, 'PickerListDrawer')
  const picker = pickers.find((node) => node.props.title === title)
  return picker?.props.items ?? []
}

function sourceInputs(renderer: ReactTestRenderer) {
  return findAllByHostType(renderer.root, 'TextInput').filter(
    (node) => node.props.placeholder === 'Type a name or search a source'
  )
}

function requestsOnly(sendRequest: RpcClient['sendRequest']): RpcClient {
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation(sendRequest)
  return client
}

function replied(result: unknown): Promise<RpcResponse> {
  return Promise.resolve({ id: 'reply', ok: true, result })
}

function runTargetPicker(renderer: ReactTestRenderer) {
  return findAllByHostType(renderer.root, 'PickerListDrawer').find(
    (node) => node.props.title === 'Run on'
  )!
}

async function flushUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('NewWorktreeModal project targets', () => {
  let renderer: ReactTestRenderer

  beforeEach(() => {
    setCachedRepos('host-1', repos)
  })

  afterEach(() => {
    act(() => renderer?.unmount())
  })

  it("lists the desktop's repos at once while a server has not answered", async () => {
    const desktop = vi.fn((method: string) =>
      method === 'repo.list' ? replied({ repos }) : new Promise<never>(() => {})
    )
    const hungServer = vi.fn(() => new Promise<never>(() => {}))

    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client: requestsOnly(desktop),
          serverClients: new Map<ExecutionHostId, RpcClient>([
            ['runtime:env-1', requestsOnly(hungServer)]
          ]),
          hostId: 'host-cold',
          onCreated: () => {},
          onClose: () => {},
          openExternalUrl: () => {}
        })
      )
    })
    await flushUpdates()

    expect(hungServer).toHaveBeenCalledWith('repo.list')
    expect(pickerItems(renderer, 'Run on').map((item) => item.detail)).toEqual(['/src/orca'])
  })

  it('keeps a server repo picked when the desktop lists a repo with the same id', async () => {
    const serverRepo = { ...repos[0]!, path: '/srv/orca' }
    const listing = (listed: unknown[]) =>
      vi.fn((method: string) =>
        method === 'repo.list' ? replied({ repos: listed }) : new Promise<never>(() => {})
      )

    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client: requestsOnly(listing(repos)),
          serverClients: new Map<ExecutionHostId, RpcClient>([
            ['runtime:env-1', requestsOnly(listing([serverRepo]))]
          ]),
          hostId: 'host-1',
          onCreated: () => {},
          onClose: () => {},
          openExternalUrl: () => {}
        })
      )
    })
    await flushUpdates()
    const picker = runTargetPicker(renderer)
    await act(async () => picker.props.onSelect(picker.props.items[1]))
    await flushUpdates()

    expect(runTargetPicker(renderer).props.selectedId).toBe('runtime:env-1')
    expect(
      renderer.root.find((node) => node.props.runTarget !== undefined).props.runTarget.detail
    ).toBe('/srv/orca')
  })

  it('ignores a stale repo list after the client changes', async () => {
    let resolveOldList: ((value: unknown) => void) | undefined
    const oldList = new Promise((resolve) => {
      resolveOldList = resolve
    })
    const freshRepo = { ...repos[0]!, id: 'repo-fresh', displayName: 'fresh' }
    const oldClient = requestsOnly(
      vi.fn().mockImplementation((method: string) => {
        if (method === 'repo.list') {
          return oldList
        }
        return new Promise(() => {})
      })
    )
    const freshClient = requestsOnly(
      vi.fn().mockImplementation((method: string) => {
        if (method === 'repo.list') {
          return Promise.resolve({ ok: true, result: { repos: [freshRepo] } })
        }
        if (method === 'status.get') {
          return Promise.resolve({ ok: true, result: { hostPlatform: 'darwin' } })
        }
        return new Promise(() => {})
      })
    )
    const modalProps = {
      visible: true,
      hostId: 'host-1',
      onCreated: () => {},
      onClose: () => {},
      openExternalUrl: () => {}
    }

    await act(async () => {
      renderer = create(createElement(NewWorktreeModal, { ...modalProps, client: oldClient }))
    })
    const sourceInput = sourceInputs(renderer)[0]!
    act(() => sourceInput.props.onChangeText('stale-client-name'))
    expect(sourceInput.props.value).toBe('stale-client-name')
    await act(async () => {
      renderer.update(createElement(NewWorktreeModal, { ...modalProps, client: freshClient }))
      await Promise.resolve()
    })
    // A reconnect changes the client without restarting this host's form session.
    expect(sourceInputs(renderer).map((input) => input.props.value)).toEqual([
      'stale-client-name',
      'stale-client-name'
    ])
    resolveOldList?.({ ok: true, result: { repos } })
    await flushUpdates()

    expect(pickerItems(renderer, 'Project')).toEqual([expect.objectContaining({ label: 'fresh' })])
  })

  // Blurred react-native-screens freezes by suspending/react-freeze; discarded render mutations otherwise outlive React’s work.
  function suspendableTree(frozen: () => boolean, child: ReactElement) {
    const never = new Promise<void>(() => {})
    const Freezer = () => {
      if (frozen()) {
        throw never
      }
      return null
    }
    // The modal renders first, so its render completes before the freeze throws.
    return createElement(Suspense, { fallback: null }, child, createElement(Freezer, null))
  }

  it('keeps the form when a host switch renders but never commits', async () => {
    setCachedRepos('host-2', repos)
    const client = requestsOnly(vi.fn().mockImplementation(() => new Promise(() => {})))
    const modalProps = {
      visible: true,
      client,
      onCreated: () => {},
      onClose: () => {},
      openExternalUrl: () => {}
    }
    let frozen = false
    const tree = (hostId: string) =>
      suspendableTree(() => frozen, createElement(NewWorktreeModal, { ...modalProps, hostId }))

    await act(async () => {
      renderer = create(tree('host-1'))
    })
    act(() => sourceInputs(renderer)[0]!.props.onChangeText('keep-me'))

    frozen = true
    await act(async () => {
      renderer.update(tree('host-2'))
    })
    frozen = false
    await act(async () => {
      renderer.update(tree('host-1'))
    })

    // host-2 never committed, so host-1's session was never superseded.
    expect(sourceInputs(renderer).map((input) => input.props.value)).toEqual(['keep-me', 'keep-me'])
  })

  it('keeps the form when a close renders but never commits', async () => {
    const client = requestsOnly(vi.fn().mockImplementation(() => new Promise(() => {})))
    const modalProps = {
      client,
      hostId: 'host-1',
      onCreated: () => {},
      onClose: () => {},
      openExternalUrl: () => {}
    }
    let frozen = false
    const tree = (visible: boolean) =>
      suspendableTree(() => frozen, createElement(NewWorktreeModal, { ...modalProps, visible }))

    await act(async () => {
      renderer = create(tree(true))
    })
    act(() => sourceInputs(renderer)[0]!.props.onChangeText('keep-me-too'))

    frozen = true
    await act(async () => {
      renderer.update(tree(false))
    })
    frozen = false
    await act(async () => {
      renderer.update(tree(true))
    })

    // The drawer never committed a closed state, so this is not a reopening.
    expect(sourceInputs(renderer).map((input) => input.props.value)).toEqual([
      'keep-me-too',
      'keep-me-too'
    ])
  })

  it('starts a fresh form session when the modal switches hosts', async () => {
    setCachedRepos('host-2', repos)
    const client = requestsOnly(vi.fn().mockImplementation(() => new Promise(() => {})))
    const modalProps = {
      visible: true,
      client,
      onCreated: () => {},
      onClose: () => {},
      openExternalUrl: () => {}
    }

    await act(async () => {
      renderer = create(createElement(NewWorktreeModal, { ...modalProps, hostId: 'host-1' }))
    })
    act(() => sourceInputs(renderer)[0]!.props.onChangeText('host-one-name'))

    await act(async () => {
      renderer.update(createElement(NewWorktreeModal, { ...modalProps, hostId: 'host-2' }))
    })

    expect(sourceInputs(renderer).map((input) => input.props.value)).toEqual(['', ''])
  })
})
