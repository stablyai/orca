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

function sourceInputs(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) =>
      node.type === 'TextInput' && node.props.placeholder === 'Type a name or search a source'
  )
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
      expect.objectContaining({ label: 'orca', detail: 'stablyai/orca' })
    ])
    expect(pickerItems(renderer, 'Run on')).toEqual([
      expect.objectContaining({ label: LOCAL_HOST_LABEL, detail: '/src/orca' })
    ])
  })

  it('groups same-name checkouts under one project with separate run targets', async () => {
    const listedRepos = [
      ...repos,
      {
        id: 'repo-2',
        displayName: 'orca',
        path: '/home/dev/orca',
        connectionId: 'build-server',
        kind: 'git',
        upstream: { owner: 'stablyai', repo: 'orca' }
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
      expect.objectContaining({ label: 'orca', detail: 'stablyai/orca' })
    ])
    expect(pickerItems(renderer, 'Run on')).toEqual([
      expect.objectContaining({ label: LOCAL_HOST_LABEL, detail: '/src/orca' }),
      expect.objectContaining({
        label: 'SSH · build-server',
        detail: '/home/dev/orca'
      })
    ])
  })

  it('loads SSH state before detecting agents on the selected remote target', async () => {
    const remoteRepo = {
      id: 'repo-remote',
      displayName: 'orca',
      path: '/home/dev/orca',
      connectionId: 'build-server',
      kind: 'git',
      upstream: { owner: 'stablyai', repo: 'orca' }
    }
    setCachedRepos('host-ssh', [remoteRepo])
    const sendRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'repo.list') {
        return Promise.resolve({ ok: true, result: { repos: [remoteRepo] } })
      }
      if (method === 'ssh.getState') {
        return Promise.resolve({
          ok: true,
          result: {
            state: {
              targetId: 'build-server',
              status: 'connected',
              error: null,
              reconnectAttempt: 0
            }
          }
        })
      }
      if (method === 'preflight.detectRemoteAgents') {
        return Promise.resolve({ ok: true, result: ['codex'] })
      }
      if (method === 'settings.get') {
        return Promise.resolve({ ok: true, result: { settings: { defaultTuiAgent: 'codex' } } })
      }
      if (method === 'ui.get') {
        return Promise.resolve({ ok: true, result: { ui: {} } })
      }
      if (method === 'preflight.check') {
        return Promise.resolve({ ok: true, result: {} })
      }
      if (method === 'linear.status') {
        return Promise.resolve({ ok: true, result: {} })
      }
      if (method === 'status.get') {
        return Promise.resolve({ ok: true, result: { hostPlatform: 'linux' } })
      }
      if (method === 'repo.hooks') {
        return Promise.resolve({ ok: true, result: { hooks: null, source: null } })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const client = { sendRequest } as unknown as RpcClient

    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client,
          hostId: 'host-ssh',
          onCreated: () => {},
          onClose: () => {}
        })
      )
    })
    await flushUpdates()

    expect(sendRequest).toHaveBeenCalledWith('ssh.getState', { targetId: 'build-server' })
    expect(sendRequest).toHaveBeenCalledWith('preflight.detectRemoteAgents', {
      connectionId: 'build-server'
    })
  })

  it('keeps folder workspaces on the local execution and text-only source path', async () => {
    const folderRepo = {
      id: 'folder-1',
      displayName: 'notes',
      path: '/src/notes',
      kind: 'folder'
    }
    setCachedRepos('host-folder', [folderRepo])
    const sendRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'repo.list') {
        return Promise.resolve({ ok: true, result: { repos: [folderRepo] } })
      }
      if (method === 'preflight.detectAgents') {
        return Promise.resolve({ ok: true, result: ['codex'] })
      }
      if (method === 'settings.get') {
        return Promise.resolve({ ok: true, result: { settings: { defaultTuiAgent: 'codex' } } })
      }
      if (method === 'ui.get') {
        return Promise.resolve({ ok: true, result: { ui: {} } })
      }
      if (method === 'preflight.check') {
        return Promise.resolve({ ok: true, result: {} })
      }
      if (method === 'linear.status') {
        return Promise.resolve({ ok: true, result: {} })
      }
      if (method === 'status.get') {
        return Promise.resolve({ ok: true, result: { hostPlatform: 'darwin' } })
      }
      if (method === 'repo.hooks') {
        return Promise.resolve({ ok: true, result: { hooks: null, source: null } })
      }
      return Promise.resolve({ ok: true, result: {} })
    })
    const client = { sendRequest } as unknown as RpcClient

    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client,
          hostId: 'host-folder',
          onCreated: () => {},
          onClose: () => {}
        })
      )
    })
    await flushUpdates()

    expect(renderer.root.findAll((node) => node.props.label === 'Workspace name')).toHaveLength(1)
    expect(sendRequest).toHaveBeenCalledWith('preflight.detectAgents')
    expect(sendRequest).not.toHaveBeenCalledWith('ssh.getState', expect.anything())
  })

  it('ignores a stale repo list after the client changes', async () => {
    let resolveOldList: ((value: unknown) => void) | undefined
    const oldList = new Promise((resolve) => {
      resolveOldList = resolve
    })
    const freshRepo = { ...repos[0]!, id: 'repo-fresh', displayName: 'fresh' }
    const oldClient = {
      sendRequest: vi.fn().mockImplementation((method: string) => {
        if (method === 'repo.list') {
          return oldList
        }
        return new Promise(() => {})
      })
    } as unknown as RpcClient
    const freshClient = {
      sendRequest: vi.fn().mockImplementation((method: string) => {
        if (method === 'repo.list') {
          return Promise.resolve({ ok: true, result: { repos: [freshRepo] } })
        }
        if (method === 'status.get') {
          return Promise.resolve({ ok: true, result: { hostPlatform: 'darwin' } })
        }
        return new Promise(() => {})
      })
    } as unknown as RpcClient
    const modalProps = {
      visible: true,
      hostId: 'host-1',
      onCreated: () => {},
      onClose: () => {}
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
    expect(sourceInputs(renderer).map((input) => input.props.value)).toEqual(['', ''])
    resolveOldList?.({ ok: true, result: { repos } })
    await flushUpdates()

    expect(pickerItems(renderer, 'Project')).toEqual([expect.objectContaining({ label: 'fresh' })])
  })

  it('remounts before the reopened session renders, so no stale instance sees visible', async () => {
    const sendRequest = vi.fn().mockImplementation(() => new Promise(() => {}))
    const client = { sendRequest } as unknown as RpcClient
    const modalProps = {
      client,
      hostId: 'host-1',
      onCreated: () => {},
      onClose: () => {}
    }

    await act(async () => {
      renderer = create(createElement(NewWorktreeModal, { ...modalProps, visible: true }))
    })
    act(() => renderer.update(createElement(NewWorktreeModal, { ...modalProps, visible: false })))
    act(() => renderer.update(createElement(NewWorktreeModal, { ...modalProps, visible: true })))

    // One repo.list per opening. A third means the previous session's instance
    // re-ran its visible-gated effects before the remount key caught up.
    const repoListCalls = sendRequest.mock.calls.filter(([method]) => method === 'repo.list')
    expect(repoListCalls).toHaveLength(2)
  })

  it('starts with fresh form state after closing and reopening', async () => {
    const client = {
      sendRequest: vi.fn().mockImplementation(() => new Promise(() => {}))
    } as unknown as RpcClient
    const modalProps = {
      client,
      hostId: 'host-1',
      onCreated: () => {},
      onClose: () => {}
    }

    await act(async () => {
      renderer = create(createElement(NewWorktreeModal, { ...modalProps, visible: true }))
    })
    const sourceInput = sourceInputs(renderer)[0]!
    act(() => sourceInput.props.onChangeText('previous-workspace'))

    act(() => renderer.update(createElement(NewWorktreeModal, { ...modalProps, visible: false })))
    act(() => renderer.update(createElement(NewWorktreeModal, { ...modalProps, visible: true })))

    expect(sourceInputs(renderer).map((input) => input.props.value)).toEqual(['', ''])
  })
})
