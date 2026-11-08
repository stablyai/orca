import { createElement, type ReactElement, type ReactNode } from 'react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileFileExplorerPanel } from './MobileFileExplorerPanel'
import type { MobileDirEntry } from './file-tree'
import { createOrcaQueryClient } from '../query/orca-query-client'
import { settleQueryNotifications } from '../test-support/rpc-recording/hook-mount'
import type { RpcClient } from '../transport/rpc-client'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { ConnectionState, RpcResponse } from '../transport/types'

const mounted: ReactTestRenderer[] = []

const mockTransport = vi.hoisted(
  (): {
    client: unknown
    connectionState: string
    forceReconnect: ReturnType<typeof vi.fn> | null
  } => ({
    client: null,
    connectionState: 'connected',
    forceReconnect: vi.fn()
  })
)

vi.mock('../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => true }))
vi.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (t: number) => t },
  default: { View: 'AnimatedView' },
  useSharedValue: (initial: number) => ({ value: initial }),
  useAnimatedStyle: () => ({}),
  withTiming: (to: number) => to
}))

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    Animated: { View: 'View' },
    FlatList: (props: {
      data: unknown[]
      keyExtractor: (item: unknown, index: number) => string
      renderItem: (info: {
        item: unknown
        index: number
        separators: Record<string, never>
      }) => ReactNode
    }) =>
      React.createElement(
        'FlatList',
        props,
        props.data.map((item, index) =>
          React.createElement(
            'FlatListItem',
            { key: props.keyExtractor(item, index) },
            props.renderItem({ item, index, separators: {} })
          )
        )
      ),
    Dimensions: { get: () => ({ width: 390, height: 844 }) },
    Keyboard: { addListener: () => ({ remove() {} }), dismiss: () => {} },
    Platform: { OS: 'web', select: (choices: Record<string, unknown>) => choices.web },
    Pressable: 'Pressable',
    StyleSheet: {
      absoluteFill: {},
      create: (styles: unknown) => styles,
      hairlineWidth: 1
    },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View'
  }
})

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Defs: 'Defs',
  LinearGradient: 'LinearGradient',
  Rect: 'Rect',
  Stop: 'Stop'
}))

vi.mock('expo-router', () => ({
  useRouter: () => ({
    back: vi.fn(),
    push: vi.fn()
  })
}))

vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  CircleAlert: 'CircleAlert',
  File: 'File',
  FileText: 'FileText',
  Folder: 'Folder',
  FolderOpen: 'FolderOpen',
  Image: 'Image',
  Search: 'Search',
  SearchX: 'SearchX',
  WifiOff: 'WifiOff',
  X: 'X'
}))

vi.mock('../platform/haptics', () => ({
  triggerSelection: vi.fn()
}))

vi.mock('./mobile-file-explorer-row-actions-sheet', () => ({
  useMobileFileExplorerRowActions: () => ({ openRowActions: () => {}, rowActionsSheet: null })
}))

vi.mock('../transport/host-client-hooks', () => ({
  useForceReconnect: () => mockTransport.forceReconnect,
  useHostClient: () => ({
    client: mockTransport.client,
    state: mockTransport.connectionState
  })
}))

function entry(name: string, isDirectory = false): MobileDirEntry {
  return { name, isDirectory }
}

function ok(result: unknown): RpcResponse {
  return { id: 'response-id', ok: true, result, _meta: { runtimeId: 'runtime-id' } }
}

type Reply = RpcResponse | Promise<RpcResponse>
type Answer = (method: string, relativePath: string, params: unknown) => Reply
type Host = {
  answer: Answer
  client: RpcClient
  setState: (renderer: ReactTestRenderer, next: ConnectionState) => Promise<void>
}

// One logical client for the whole test, as on a phone: the socket comes and goes, the client stays.
function createHost(answer: Answer): Host {
  let state: ConnectionState = 'connected'
  const listeners = new Set<(state: ConnectionState) => void>()
  const host: Host = {
    answer,
    client: stubRpcClient({
      getState: () => state,
      onStateChange: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      // The transport's failWhenDisconnected contract: refuse at once while down.
      sendRequest: async (method, params, options): Promise<RpcResponse> => {
        if (options?.failWhenDisconnected && state !== 'connected') {
          throw new Error(`Not connected: ${method}`)
        }
        const relativePath =
          typeof params === 'object' && params !== null && 'relativePath' in params
            ? String(params.relativePath)
            : ''
        return host.answer(method, relativePath, params)
      }
    }),
    async setState(renderer: ReactTestRenderer, next: ConnectionState) {
      state = next
      mockTransport.connectionState = next
      await act(async () => {
        listeners.forEach((listener) => listener(next))
      })
      await updateExplorer(renderer)
    }
  }
  mockTransport.client = host.client
  return host
}

function listingHost(entriesByPath: Record<string, MobileDirEntry[]>) {
  return createHost((_method, relativePath) => ok(entriesByPath[relativePath] ?? []))
}

function deferred() {
  let resolve: (response: RpcResponse) => void = () => {}
  const promise = new Promise<RpcResponse>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let queryClient: QueryClient = createOrcaQueryClient()

function explorer(): ReactElement {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(MobileFileExplorerPanel, {
      hostId: 'host-a',
      worktreeId: 'worktree-a',
      name: 'Example Worktree',
      embedded: true
    })
  )
}

async function renderExplorer(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(explorer())
  })
  if (!renderer) {
    throw new Error('MobileFileExplorerPanel did not render')
  }
  mounted.push(renderer)
  await settleQueryNotifications()
  return renderer
}

async function updateExplorer(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.update(explorer())
  })
  await settleQueryNotifications()
}

async function pressByLabel(
  renderer: ReactTestRenderer,
  accessibilityLabel: string
): Promise<void> {
  const pressable = renderer.root
    .findAll((node) => String(node.type) === 'Pressable')
    .find((node) => node.props.accessibilityLabel === accessibilityLabel)
  if (!pressable) {
    throw new Error(`Unable to find pressable: ${accessibilityLabel}`)
  }
  await act(async () => {
    pressable.props.onPress()
  })
  await settleQueryNotifications()
}

async function pressText(renderer: ReactTestRenderer, text: string): Promise<void> {
  const pressable = renderer.root
    .findAll((node) => String(node.type) === 'Pressable')
    .find((node) =>
      node
        .findAll((child) => String(child.type) === 'Text')
        .some((child) => child.props.children === text)
    )
  if (!pressable) {
    throw new Error(`Unable to find pressable: ${text}`)
  }
  await act(async () => {
    pressable.props.onPress()
  })
  await settleQueryNotifications()
}

async function typeFilter(renderer: ReactTestRenderer, text: string): Promise<void> {
  const input = renderer.root.find((node) => String(node.type) === 'TextInput')
  await act(async () => {
    input.props.onChangeText(text)
  })
  await settleQueryNotifications()
}

// A host that pages: `limit` rows strictly after the `after` cursor, as files.readDir does since #35115.
function pagingHost(folders: Record<string, MobileDirEntry[]>) {
  return createHost((_method, relativePath, params) => {
    const entries = folders[relativePath] ?? []
    const page = typeof params === 'object' && params !== null ? params : {}
    const after = 'after' in page && typeof page.after === 'object' ? page.after : null
    const afterName = after !== null && 'name' in after ? after.name : undefined
    const start = entries.findIndex((candidate) => candidate.name === afterName) + 1
    const limit = 'limit' in page && typeof page.limit === 'number' ? page.limit : entries.length
    return ok({
      entries: entries.slice(start, start + limit),
      total: entries.length,
      hasMore: start + limit < entries.length
    })
  })
}

function snapshots(count: number): MobileDirEntry[] {
  return Array.from({ length: count }, (_, index) =>
    entry(`snap-${String(index + 1).padStart(4, '0')}.png`)
  )
}

function renderedText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => String(node.type) === 'Text')
    .flatMap((node) => node.props.children)
    .join(' ')
}

describe('MobileFileExplorerPanel', () => {
  afterEach(() => {
    for (const renderer of mounted.splice(0)) {
      act(() => renderer.unmount())
    }
    vi.restoreAllMocks()
    queryClient.clear()
    queryClient = createOrcaQueryClient()
    mockTransport.client = null
    mockTransport.connectionState = 'connected'
    mockTransport.forceReconnect = vi.fn()
  })

  it('reopens Files with the last listing while the refresh is still out', async () => {
    const host = listingHost({ '': [entry('src', true), entry('README.md')] })
    const first = await renderExplorer()
    act(() => first.unmount())

    const refresh = deferred()
    host.answer = () => refresh.promise
    // Past the listing's freshness, so reopening revalidates.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    const reopened = await renderExplorer()
    expect(renderedText(reopened)).toContain('README.md')
    expect(renderedText(reopened)).not.toContain('Loading files')

    await act(async () => {
      refresh.resolve(ok([entry('src', true), entry('CHANGELOG.md')]))
    })
    await settleQueryNotifications()
    expect(renderedText(reopened)).toContain('CHANGELOG.md')
    expect(renderedText(reopened)).not.toContain('README.md')
  })

  it('paints the last listing before the host client attaches', async () => {
    listingHost({ '': [entry('src', true), entry('README.md')] })
    const first = await renderExplorer()
    act(() => first.unmount())

    // A remount reads its client in an effect, so the first render has none.
    mockTransport.client = null
    const reopened = await renderExplorer()
    expect(renderedText(reopened)).toContain('README.md')
    expect(renderedText(reopened)).not.toContain('Loading files')
  })

  it('keeps the loaded tree visible during a transient disconnect', async () => {
    const host = listingHost({ '': [entry('src', true), entry('README.md')] })
    const renderer = await renderExplorer()
    expect(renderedText(renderer)).toContain('src')

    await host.setState(renderer, 'disconnected')

    expect(renderedText(renderer)).toContain('src')
    expect(renderedText(renderer)).toContain('README.md')
    expect(renderedText(renderer)).not.toContain('Waiting for desktop')
  })

  it('refreshes the root in the background after reconnect without blanking the tree', async () => {
    const host = listingHost({ '': [entry('src', true), entry('README.md')] })
    const renderer = await renderExplorer()
    expect(renderedText(renderer)).toContain('README.md')

    await host.setState(renderer, 'disconnected')
    const reload = deferred()
    host.answer = () => reload.promise
    await host.setState(renderer, 'connected')

    expect(renderedText(renderer)).toContain('src')
    expect(renderedText(renderer)).toContain('README.md')

    await act(async () => {
      reload.resolve(ok([entry('src', true), entry('README.md'), entry('CHANGELOG.md')]))
    })
    await settleQueryNotifications()
    expect(renderedText(renderer)).toContain('CHANGELOG.md')
  })

  it('keeps an open folder’s rows while it refreshes after reconnect, then shows the new ones', async () => {
    const host = listingHost({
      '': [entry('src', true)],
      src: [entry('deleted-while-offline.ts')]
    })
    const renderer = await renderExplorer()
    await pressByLabel(renderer, 'Open folder src')
    expect(renderedText(renderer)).toContain('deleted-while-offline.ts')

    await host.setState(renderer, 'disconnected')
    const srcRefresh = deferred()
    host.answer = (_method, relativePath) =>
      relativePath === 'src' ? srcRefresh.promise : ok([entry('src', true)])
    await host.setState(renderer, 'connected')
    expect(renderedText(renderer)).toContain('deleted-while-offline.ts')
    expect(renderer.root.findAll((node) => String(node.type) === 'ActivityIndicator')).toEqual([])

    await act(async () => {
      srcRefresh.resolve(ok([entry('created-while-offline.ts')]))
    })
    await settleQueryNotifications()
    expect(renderedText(renderer)).toContain('created-while-offline.ts')
    expect(renderedText(renderer)).not.toContain('deleted-while-offline.ts')
  })

  it('rereads a previously cached collapsed folder when reopened after reconnect', async () => {
    const host = listingHost({
      '': [entry('src', true)],
      src: [entry('deleted-while-offline.ts')]
    })
    const renderer = await renderExplorer()
    await pressByLabel(renderer, 'Open folder src')
    await pressByLabel(renderer, 'Open folder src')

    await host.setState(renderer, 'disconnected')
    host.answer = (_method, relativePath) =>
      ok(relativePath === 'src' ? [entry('created-while-offline.ts')] : [entry('src', true)])
    await host.setState(renderer, 'connected')
    await pressByLabel(renderer, 'Open folder src')

    expect(renderedText(renderer)).toContain('created-while-offline.ts')
    expect(renderedText(renderer)).not.toContain('deleted-while-offline.ts')
  })

  it('keeps the cached tree when a post-reconnect root refresh fails', async () => {
    const host = listingHost({ '': [entry('src', true), entry('README.md')] })
    const renderer = await renderExplorer()
    expect(renderedText(renderer)).toContain('README.md')

    await host.setState(renderer, 'disconnected')
    host.answer = () => Promise.reject(new Error('refresh failed'))
    await host.setState(renderer, 'connected')

    expect(renderedText(renderer)).toContain('src')
    expect(renderedText(renderer)).toContain('README.md')
    expect(renderedText(renderer)).not.toContain('refresh failed')
  })

  it('falls back to the capped files.list against desktops without files.readDir', async () => {
    createHost((method) =>
      method === 'files.readDir'
        ? {
            id: 'response-id',
            ok: false,
            error: {
              code: 'forbidden',
              message: "Method 'files.readDir' is not available to mobile clients"
            },
            _meta: { runtimeId: 'runtime-id' }
          }
        : ok({
            files: [
              { relativePath: 'src/app.ts', basename: 'app.ts', kind: 'text' },
              { relativePath: 'README.md', basename: 'README.md', kind: 'text' }
            ],
            totalCount: 2,
            truncated: false
          })
    )
    const renderer = await renderExplorer()
    expect(renderedText(renderer)).toContain('src')
    expect(renderedText(renderer)).toContain('README.md')

    // The folder comes from the synthesized tree; a readDir for it would fail on this desktop.
    await pressByLabel(renderer, 'Open folder src')
    expect(renderedText(renderer)).toContain('app.ts')
  })

  it('pages a big folder with Show more, and a reconnect keeps the pages already shown', async () => {
    const host = pagingHost({
      '': [entry('snapshots', true), entry('videos', true)],
      snapshots: snapshots(1200)
    })
    const renderer = await renderExplorer()
    await pressByLabel(renderer, 'Open folder snapshots')
    expect(renderedText(renderer)).toContain('snap-0500.png')
    expect(renderedText(renderer)).not.toContain('snap-0501.png')
    expect(renderedText(renderer)).toContain('1,200')
    expect(renderedText(renderer)).toContain('500 of 1,200')

    await pressText(renderer, 'Show 500 more')
    expect(renderedText(renderer)).toContain('snap-1000.png')
    expect(renderedText(renderer)).not.toContain('snap-1001.png')
    expect(renderedText(renderer)).toContain('Show 200 more')
    expect(renderedText(renderer)).toContain('videos')

    await host.setState(renderer, 'disconnected')
    await host.setState(renderer, 'connected')
    expect(renderedText(renderer)).toContain('snap-1000.png')
    expect(renderedText(renderer)).toContain('1,000 of 1,200')
  })

  it('says how much of a closed, part-loaded folder the filter searched, and Search all reads the rest', async () => {
    pagingHost({ '': [entry('snapshots', true)], snapshots: snapshots(12_000) })
    const renderer = await renderExplorer()
    // Closed again, so only the cache holds its rows and nothing observes the appends.
    await pressByLabel(renderer, 'Open folder snapshots')
    await pressByLabel(renderer, 'Open folder snapshots')
    await typeFilter(renderer, 'snap-110')
    expect(renderedText(renderer)).not.toContain('snap-1100.png')
    expect(renderedText(renderer)).toContain('Searched 500 of 12,000 in snapshots.')

    await pressByLabel(renderer, 'Search all of snapshots')
    expect(renderedText(renderer)).toContain('snap-1100.png')
    expect(renderedText(renderer)).toContain('snap-11000.png')
    expect(renderedText(renderer)).not.toContain('Searched')
  })

  it('filters a folder whose read finished after it was closed', async () => {
    const srcRead = deferred()
    createHost((_method, relativePath) =>
      relativePath === 'src' ? srcRead.promise : ok([entry('src', true)])
    )
    const renderer = await renderExplorer()
    await pressByLabel(renderer, 'Open folder src')
    await pressByLabel(renderer, 'Open folder src')
    await act(async () => {
      srcRead.resolve(ok([entry('app.ts')]))
    })
    await settleQueryNotifications()

    await typeFilter(renderer, 'app')
    expect(renderedText(renderer)).toContain('app.ts')
  })

  describe('Retry while the host is unreachable', () => {
    it("keeps a folder's Retry on the page, whose read runs when the shell reconnects", async () => {
      // The page cannot re-dial; the connected edge reads the folder.
      mockTransport.forceReconnect = null
      const host = createHost((_method, relativePath) =>
        relativePath === 'src'
          ? {
              id: 'response-id',
              ok: false,
              error: { code: 'internal', message: 'read failed' },
              _meta: { runtimeId: 'runtime-id' }
            }
          : ok([entry('src', true)])
      )
      const renderer = await renderExplorer()
      await pressByLabel(renderer, 'Open folder src')
      expect(renderedText(renderer)).toContain('read failed')

      await host.setState(renderer, 'reconnecting')
      host.answer = (_method, relativePath) =>
        ok(relativePath === '' ? [entry('src', true)] : [entry('app.ts')])
      await pressByLabel(renderer, 'Retry loading src')
      await host.setState(renderer, 'connected')

      expect(renderedText(renderer)).toContain('app.ts')
      expect(renderedText(renderer)).not.toContain('read failed')
    })
  })
})
