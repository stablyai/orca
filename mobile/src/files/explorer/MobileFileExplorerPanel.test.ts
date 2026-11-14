import { createElement, type ReactElement, type ReactNode } from 'react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileFileExplorerPanel } from './MobileFileExplorerPanel'
import type { MobileDirEntry } from './file-tree'
import { createOrcaQueryClient } from '../../query/orca-query-client'
import { settleQueryNotifications } from '../../test-support/rpc-recording/hook-mount'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { stubRpcClient } from '../../transport/rpc/rpc-client-test-stub'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'

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

vi.mock('../../platform/accessibility/use-reduced-motion', () => ({
  useReducedMotionEnabled: () => true
}))
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

vi.mock('../../platform/haptics/haptics', () => ({
  triggerSelection: vi.fn()
}))

vi.mock('./mobile-file-explorer-row-actions-sheet', () => ({
  useMobileFileExplorerRowActions: () => ({ openRowActions: () => {}, rowActionsSheet: null })
}))

vi.mock('../../transport/connection/host-client-hooks', () => ({
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

async function typeFilter(renderer: ReactTestRenderer, text: string): Promise<void> {
  const input = renderer.root.find((node) => String(node.type) === 'TextInput')
  await act(async () => {
    input.props.onChangeText(text)
  })
  await settleQueryNotifications()
}

// A host that pages: `limit` rows strictly after the `after` cursor, as files.readDir does since #35115.

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
