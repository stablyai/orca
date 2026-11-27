import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn().mockResolvedValue(null),
  setItem: vi.fn().mockResolvedValue(undefined),
  removeItem: vi.fn().mockResolvedValue(undefined)
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
vi.mock('./BottomDrawer', () => ({ BottomDrawer: 'BottomDrawer' }))
vi.mock('./bottom-drawer-modal-host', () => ({ BottomDrawerModalHost: 'BottomDrawerModalHost' }))
vi.mock('./PickerListDrawer', () => ({ PickerListDrawer: 'PickerListDrawer' }))
vi.mock('./MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))
vi.mock('./TaskProviderLogo', () => ({ TaskProviderLogo: 'TaskProviderLogo' }))

import { getCachedRepos, setCachedRepos } from '../cache/repo-cache'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { NewWorktreeModal } from './NewWorktreeModal'

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
  const pickers = renderer.root.findAll((node) => node.type === 'PickerListDrawer')
  const picker = pickers.find((node) => node.props.title === title)
  return picker?.props.items ?? []
}

function requestsOnly(sendRequest: RpcClient['sendRequest']): RpcClient {
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation(sendRequest)
  return client
}

const flushUpdates = async () =>
  act(async () => {
    for (let i = 0; i < 3; i++) {
      await Promise.resolve()
    }
  })

const flushDrawerTransition = async () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 200))
  })

describe('NewWorktreeModal add project flow', () => {
  let renderer: ReactTestRenderer

  beforeEach(() => {
    setCachedRepos('host-1', repos)
  })

  afterEach(() => {
    renderer?.unmount()
  })

  function makeBrowseClient(
    listedRepos: unknown[] | Promise<unknown> = repos,
    addedRepo?: unknown
  ) {
    return requestsOnly(
      vi.fn().mockImplementation(async (method: string) => {
        if (method === 'repo.list') {
          const res = await listedRepos
          return Array.isArray(res) ? { ok: true, result: { repos: res } } : res
        }
        if (method === 'status.get') {
          return { ok: true, result: { hostPlatform: 'darwin' } }
        }
        if (method === 'files.browseServerDir') {
          return {
            ok: true,
            result: { resolvedPath: '/Users/test', entries: [], pathFlavor: 'posix' }
          }
        }
        if (method === 'repo.add') {
          return { ok: true, result: { repo: addedRepo } }
        }
        return { ok: true, result: {} }
      })
    )
  }

  async function triggerAddProjectFromPicker(target: ReactTestRenderer) {
    const picker = target.root.find(
      (n) => n.type === 'PickerListDrawer' && n.props.title === 'Project'
    )
    await act(async () => picker.props.footer.props.onPress())
    await flushDrawerTransition()
    await flushUpdates()
    const addBtn = target.root
      .findAll(
        (n) =>
          n.type === 'Pressable' && n.findAll((c) => c.props.children === 'Add project').length > 0
      )
      .find((b) => !b.props.disabled && b.props.onPress)!
    await act(async () => addBtn.props.onPress())
    await flushUpdates()
    await flushDrawerTransition()
  }

  it('opens addProject drawer from the empty projects state', async () => {
    setCachedRepos('host-empty', [])
    const client = makeBrowseClient([])
    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client,
          hostId: 'host-empty',
          onCreated: () => {},
          onClose: () => {}
        })
      )
    })
    await flushUpdates()
    const addBtn = renderer.root.findAll(
      (n) =>
        n.type === 'Pressable' && n.findAll((c) => c.props.children === 'Add project').length > 0
    )[0]!
    await act(async () => addBtn.props.onPress())
    await flushDrawerTransition()
    await flushUpdates()
    expect(client.sendRequest).toHaveBeenCalledWith('files.browseServerDir', { path: '~' })
  })

  it('opens addProject from picker footer, upserts and selects the added project', async () => {
    const added = { id: 'repo-added-1', displayName: 'new-orca', path: '/Users/test', kind: 'git' }
    const client = makeBrowseClient(repos, added)
    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client,
          hostId: 'host-1',
          onCreated: () => {},
          onClose: () => {}
        })
      )
    })
    await flushUpdates()
    await triggerAddProjectFromPicker(renderer)
    expect(client.sendRequest).toHaveBeenCalledWith('files.browseServerDir', { path: '~' })
    expect(client.sendRequest).toHaveBeenCalledWith('repo.add', {
      path: '/Users/test',
      kind: 'git'
    })
    expect(pickerItems(renderer, 'Project')).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'new-orca' })])
    )
    expect(getCachedRepos('host-1')).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'repo-added-1' })])
    )
  })

  it('preserves an added project when an older in-flight repo.list resolves later', async () => {
    let resolveList: ((value: unknown) => void) | undefined
    const listPromise = new Promise((resolve) => {
      resolveList = resolve
    })
    const added = {
      id: 'repo-added-late',
      displayName: 'late-orca',
      path: '/Users/test',
      kind: 'git'
    }
    const client = makeBrowseClient(listPromise, added)
    setCachedRepos('host-late', repos)
    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client,
          hostId: 'host-late',
          onCreated: () => {},
          onClose: () => {}
        })
      )
    })
    await flushUpdates()
    await triggerAddProjectFromPicker(renderer)

    expect(pickerItems(renderer, 'Project')).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'late-orca' })])
    )

    await act(async () => {
      resolveList?.({ ok: true, result: { repos } })
      await Promise.resolve()
    })
    await flushUpdates()

    expect(pickerItems(renderer, 'Project')).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'late-orca' })])
    )
  })

  it('directly opens primary worktree when an added project already has a checkout', async () => {
    const added = { id: 'repo-added-wt', displayName: 'wt-orca', path: '/Users/test', kind: 'git' }
    const client = requestsOnly(
      vi.fn(async (method: string) => {
        if (method === 'repo.list') {
          return { ok: true, result: { repos } }
        }
        if (method === 'status.get') {
          return { ok: true, result: { hostPlatform: 'darwin' } }
        }
        if (method === 'files.browseServerDir') {
          return {
            ok: true,
            result: { resolvedPath: '/Users/test', entries: [], pathFlavor: 'posix' }
          }
        }
        if (method === 'repo.add') {
          return { ok: true, result: { repo: added } }
        }
        if (method === 'worktree.ps') {
          return {
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'wt-primary-1',
                  repoId: 'repo-added-wt',
                  displayName: 'main',
                  isMainWorktree: true
                }
              ]
            }
          }
        }
        return { ok: true, result: {} }
      })
    )
    const onClose = vi.fn()
    const onOpenWorktree = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client,
          hostId: 'host-1',
          onCreated: () => {},
          onOpenWorktree,
          onClose
        })
      )
    })
    await flushUpdates()
    await triggerAddProjectFromPicker(renderer)

    expect(client.sendRequest).toHaveBeenCalledWith('worktree.ps', { limit: 10_000 })
    expect(onClose).toHaveBeenCalled()
    expect(onOpenWorktree).toHaveBeenCalledWith('wt-primary-1', 'main', undefined)
  })
})
