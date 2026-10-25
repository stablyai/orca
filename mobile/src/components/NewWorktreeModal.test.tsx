import { createElement, Suspense, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'

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
import { recordHostDescriptor } from '../transport/host-descriptor-store'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import {
  getLocalExecutionHostLabel,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { MOBILE_RELAY_HOSTS_LIST_METHOD } from '../../../src/shared/mobile-relay-hosts-contract'
import { NewWorktreeModal } from './NewWorktreeModal'
import { NewWorktreeModalController } from './NewWorktreeModalController'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

const RelayedOptionsSchema = z.object({ envelope: z.object({ executionHost: z.string() }) })

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
    const client = requestsOnly(sendRequest)

    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client,
          hostId: 'host-1',
          onCreated: () => {},
          onClose: () => {},
          openExternalUrl: () => {}
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
    const client = requestsOnly(
      vi.fn().mockImplementation((method: string) => {
        if (method === 'repo.list') {
          return Promise.resolve({ ok: true, result: { repos: listedRepos } })
        }
        if (method === 'status.get') {
          return Promise.resolve({ ok: true, result: { hostPlatform: 'darwin' } })
        }
        return new Promise(() => {})
      })
    )

    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client,
          hostId: 'host-1',
          onCreated: () => {},
          onClose: () => {},
          openExternalUrl: () => {}
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
        label: 'build-server',
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
    let resolveSshState: ((reply: unknown) => void) | undefined
    const sshState = new Promise((resolve) => {
      resolveSshState = resolve
    })
    const sendRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'repo.list') {
        return Promise.resolve({ ok: true, result: { repos: [remoteRepo] } })
      }
      if (method === 'ssh.getState') {
        return sshState
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
    const client = requestsOnly(sendRequest)

    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client,
          hostId: 'host-ssh',
          onCreated: () => {},
          onClose: () => {},
          openExternalUrl: () => {}
        })
      )
    })
    await flushUpdates()

    expect(sendRequest).toHaveBeenCalledWith('ssh.getState', { targetId: 'build-server' })
    expect(
      sendRequest.mock.calls.some(([method]) => method === 'preflight.detectRemoteAgents')
    ).toBe(false)
    await act(async () => {
      resolveSshState?.({
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
    })
    await flushUpdates()
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
    const client = requestsOnly(sendRequest)

    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client,
          hostId: 'host-folder',
          onCreated: () => {},
          onClose: () => {},
          openExternalUrl: () => {}
        })
      )
    })
    await flushUpdates()

    expect(renderer.root.findAll((node) => node.props.label === 'Workspace name')).toHaveLength(1)
    expect(sendRequest).toHaveBeenCalledWith('preflight.detectAgents', { repoId: 'folder-1' })
    expect(sendRequest).not.toHaveBeenCalledWith('ssh.getState', expect.anything())
    expect(sendRequest.mock.calls.map(([method]) => method)).not.toContain(
      'worktree.prefetchCreateBase'
    )
  })

  it("warms the host's create for the picked repo as soon as the form opens", async () => {
    const sendRequest = vi.fn().mockImplementation((method: string) => {
      if (method === 'repo.list') {
        return Promise.resolve({ ok: true, result: { repos } })
      }
      if (method === 'status.get') {
        return Promise.resolve({ ok: true, result: { hostPlatform: 'darwin' } })
      }
      if (method === 'repo.hooks') {
        return Promise.resolve({ ok: true, result: { hooks: null, source: null } })
      }
      return Promise.resolve({ ok: true, result: {} })
    })

    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client: requestsOnly(sendRequest),
          hostId: 'host-1',
          onCreated: () => {},
          onClose: () => {},
          openExternalUrl: () => {}
        })
      )
    })
    await flushUpdates()

    // Without this the host fetches the base and checks out every file inside worktree.create.
    const prefetches = sendRequest.mock.calls.filter(
      ([method]) => method === 'worktree.prefetchCreateBase'
    )
    expect(prefetches).toHaveLength(1)
    expect(prefetches[0]?.[1]).toEqual({ repo: 'id:repo-1' })
  })

  it("creates a server repo's workspace on that server and names it for the route", async () => {
    const serverRepo = { ...repos[0]!, id: 'server-repo', path: '/srv/orca' }
    const serverSshRepo = { ...serverRepo, id: 'server-ssh', connectionId: 'its-own-ssh' }
    const reply = (method: string, listed: unknown[], hostPlatform: string) => {
      if (method === 'repo.list') {
        return replied({ repos: listed })
      }
      if (method === 'status.get') {
        return replied({ hostPlatform })
      }
      if (method === 'worktree.create') {
        return replied({
          worktree: { id: 'srv-wt', displayName: 'srv-wt', path: '/srv/orca-wt' }
        })
      }
      if (method === 'settings.get') {
        return replied({ settings: {} })
      }
      return replied({})
    }
    const desktop = vi.fn((method: string) => reply(method, repos, 'darwin'))
    const server = vi.fn((method: string) => reply(method, [serverRepo, serverSshRepo], 'linux'))
    const onCreated = vi.fn()
    recordHostDescriptor('host-1', { machineName: null, platform: 'darwin' })

    await act(async () => {
      renderer = create(
        createElement(NewWorktreeModal, {
          visible: true,
          client: requestsOnly(desktop),
          serverClients: new Map<ExecutionHostId, RpcClient>([
            ['runtime:env-1', requestsOnly(server)]
          ]),
          hostId: 'host-1',
          hostLabelById: new Map<ExecutionHostId, string>([['runtime:env-1', 'scratch-server']]),
          onCreated,
          onClose: () => {},
          openExternalUrl: () => {}
        })
      )
    })
    await flushUpdates()

    const runTargets = pickerItems(renderer, 'Run on')
    expect(runTargets.map((item) => [item.label, item.detail])).toEqual([
      [LOCAL_HOST_LABEL, '/src/orca'],
      ['scratch-server', '/srv/orca']
    ])
    const serverTarget = runTargetPicker(renderer)
    const iconOf = (item: unknown) => {
      let icon: ReactTestRenderer | undefined
      act(() => {
        icon = create(serverTarget.props.renderIcon(item))
      })
      return icon?.toJSON()
    }
    expect(serverTarget.props.items.map(iconOf)).toMatchObject([
      { type: 'Monitor' },
      { type: 'Server' }
    ])
    await act(async () => serverTarget.props.onSelect(serverTarget.props.items[1]))
    await flushUpdates()
    // The Run on field shows the picked server's glyph, as its row does.
    expect(findAllByHostType(renderer.root, 'Server')).toHaveLength(1)
    expect(pickerItems(renderer, 'Run on')[0]?.label).toBe(LOCAL_HOST_LABEL)
    act(() => sourceInputs(renderer)[0]!.props.onChangeText('srv-wt'))
    const form = renderer.root.find((node) => typeof node.props.onCreate === 'function')
    await act(async () => form.props.onCreate())
    await flushUpdates()

    expect(server).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ repo: 'id:server-repo' }),
      expect.anything()
    )
    expect(desktop).not.toHaveBeenCalledWith(
      'worktree.create',
      expect.anything(),
      expect.anything()
    )
    expect(onCreated).toHaveBeenCalledWith('srv-wt', expect.any(String), undefined, 'runtime:env-1')
  })

  it("offers the desktop's servers, by name, in a sheet opened before the list has them", async () => {
    const serverRepo = { ...repos[0]!, id: 'server-repo', path: '/srv/orca' }
    // One desktop: its own repos, its server list, and a server's repos relayed through it.
    const desktop = new FakeSession('connected')
    desktop.sendRequest.mockImplementation(async (method: string, ...rest: unknown[]) => {
      const relayed = RelayedOptionsSchema.safeParse(rest[1]).data?.envelope.executionHost
      const result =
        method === MOBILE_RELAY_HOSTS_LIST_METHOD
          ? {
              hosts: [
                { hostId: 'runtime:vm', label: 'scratch-vm', health: 'available', relay: 'ready' }
              ]
            }
          : method === 'repo.list'
            ? { repos: relayed === 'runtime:vm' ? [serverRepo] : repos }
            : {}
      return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
    })
    const listCalls = () =>
      desktop.sendRequest.mock.calls.filter(([method]) => method === MOBILE_RELAY_HOSTS_LIST_METHOD)
    // The host list's own names: no server rows have loaded behind a sheet opened from Home.
    const sheet = (visible: boolean) =>
      createElement(NewWorktreeModalController, {
        visible,
        client: desktop,
        hostCapabilities: [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY],
        hostId: 'host-1',
        hostLabelById: new Map(),
        openExternalUrl: () => {},
        onCreated: () => {},
        onClose: () => {}
      })

    await act(async () => {
      renderer = create(sheet(false))
    })
    await flushUpdates()
    // Closed, it asks nothing of the desktop.
    expect(listCalls()).toHaveLength(0)

    await act(async () => renderer.update(sheet(true)))
    await flushUpdates()
    expect(pickerItems(renderer, 'Run on').map((item) => [item.label, item.detail])).toEqual([
      [expect.any(String), '/src/orca'],
      ['scratch-vm', '/srv/orca']
    ])
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

  // react-native-screens freezes a blurred screen by suspending its subtree
  // (react-freeze), so React runs this component and then throws that render away.
  // Anything the render mutated in place outlives the work React discarded.
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

  it('starts with fresh form state after closing and reopening', async () => {
    const sendRequest = vi.fn().mockImplementation(() => new Promise(() => {}))
    const client = requestsOnly(sendRequest)
    const modalProps = {
      client,
      hostId: 'host-1',
      onCreated: () => {},
      onClose: () => {},
      openExternalUrl: () => {}
    }

    await act(async () => {
      renderer = create(createElement(NewWorktreeModal, { ...modalProps, visible: true }))
    })
    const sourceInput = sourceInputs(renderer)[0]!
    act(() => sourceInput.props.onChangeText('previous-workspace'))

    act(() => renderer.update(createElement(NewWorktreeModal, { ...modalProps, visible: false })))
    act(() => renderer.update(createElement(NewWorktreeModal, { ...modalProps, visible: true })))

    expect(sourceInputs(renderer).map((input) => input.props.value)).toEqual(['', ''])
    expect(sendRequest.mock.calls.filter(([method]) => method === 'repo.list')).toHaveLength(2)
  })
})
