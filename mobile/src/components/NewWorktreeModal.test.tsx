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
vi.mock('./BottomDrawer', () => ({ BottomDrawer: 'BottomDrawer' }))
vi.mock('./bottom-drawer-modal-host', () => ({ BottomDrawerModalHost: 'BottomDrawerModalHost' }))
vi.mock('./PickerListDrawer', () => ({ PickerListDrawer: 'PickerListDrawer' }))
vi.mock('./MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))
vi.mock('./TaskProviderLogo', () => ({ TaskProviderLogo: 'TaskProviderLogo' }))

import { setCachedRepos } from '../cache/repo-cache'
import { getLocalExecutionHostLabel } from '../../../src/shared/execution-host'
import { NewWorktreeModal } from './NewWorktreeModal'

const LOCAL_HOST_LABEL = getLocalExecutionHostLabel('darwin')

const repos = [
  {
    id: 'repo-1',
    displayName: 'mcode',
    path: '/src/mcode',
    kind: 'git',
    upstream: { owner: 'stablyai', repo: 'mcode' }
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

describe('NewWorktreeModal project targets', () => {
  let renderer: ReactTestRenderer

  beforeEach(() => {
    setCachedRepos('host-1', repos)
  })

  afterEach(() => {
    act(() => renderer?.unmount())
  })

  it('keeps the cached repos when the in-flight repo.list rejects on a dropped connection', async () => {
    const sendRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'repo.list') {
        return Promise.reject(new Error('connection closed'))
      }
      if (method === 'status.get') {
        return Promise.resolve({ ok: true, result: { hostPlatform: 'darwin' } })
      }
      return new Promise(() => {})
    })
    const client = { sendRequest } as unknown as RpcClient

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
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(sendRequest).toHaveBeenCalledWith('repo.list')
    expect(pickerItems(renderer, 'Project')).toEqual([
      expect.objectContaining({ label: 'mcode', detail: 'mcode-ide/mcode' })
    ])
    expect(pickerItems(renderer, 'Run on')).toEqual([
      expect.objectContaining({ label: LOCAL_HOST_LABEL, detail: '/src/mcode' })
    ])
  })

  it('groups same-name checkouts under one project with separate run targets', async () => {
    const listedRepos = [
      ...repos,
      {
        id: 'repo-2',
        displayName: 'mcode',
        path: '/home/dev/mcode',
        connectionId: 'build-server',
        kind: 'git',
        upstream: { owner: 'stablyai', repo: 'mcode' }
      }
    ]
    const client = {
      sendRequest: vi.fn().mockImplementation((method: string) => {
        if (method === 'repo.list') {
          return Promise.resolve({ ok: true, result: { repos: listedRepos } })
        }
        if (method === 'status.get') {
          return Promise.resolve({ ok: true, result: { hostPlatform: 'darwin' } })
        }
        return new Promise(() => {})
      })
    } as unknown as RpcClient

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
      await Promise.resolve()
    })

    expect(pickerItems(renderer, 'Project')).toEqual([
      expect.objectContaining({ label: 'mcode', detail: 'mcode-ide/mcode' })
    ])
    expect(pickerItems(renderer, 'Run on')).toEqual([
      expect.objectContaining({ label: LOCAL_HOST_LABEL, detail: '/src/mcode' }),
      expect.objectContaining({
        label: 'SSH · build-server',
        detail: '/home/dev/mcode'
      })
    ])
  })
})
