import { createElement, type ComponentType, type ReactElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { vi, type Mock } from 'vitest'
import type { FakeRpcClient } from './bridge-host-test-fakes'
import {
  createDownloadProgressFeed,
  downloadFraction,
  type PublishedDownloadProgressFeed
} from './download-progress-feed'
import type {
  MobileWebShellSessionState,
  MobileWebShellUpdateNotice
} from './mobile-web-shell-session-contract'
import type { ShellPageFrame } from './shell-page-frame'
import type { NativeStackState } from './native-stack-return'

// Keep mutable fixtures outside cases while vi.mock registration stays in each test module.
export type ScreenDependencies = {
  retry: Mock
  reportShellFailure: Mock
  reportDocumentStarted: Mock
  reportDocumentLoaded: Mock
  reportPageReady: Mock
  reportPagePainted: Mock
  snapshotUnreadable: boolean
  storageRefreshes: number
  openUrl: Mock
  push: Mock
  back: Mock
  canGoBack: boolean
  rootState: NativeStackState | undefined
  dispatch: Mock
  pathname: string
  pageRoutes: readonly string[]
  routeGrants: readonly string[]
  lifecycle: string[]
  viewRenders: number
  posted: string[]
  postFails: boolean
  state: MobileWebShellSessionState
  downloadProgress: PublishedDownloadProgressFeed
  updateNotice: MobileWebShellUpdateNotice | null
  pageReady: boolean
  pageFrame: ShellPageFrame
  client: FakeRpcClient | null
  keyboardListeners: Map<string, (event: { endCoordinates: { height: number } }) => void>
  backHandlers: Map<string, () => boolean>
  setScreenOptions: Mock
  backClaimed: boolean
  platform: 'ios' | 'android'
  reportPageBackClaim: Mock
  sendBackDelivers: boolean
  backSends: number
}

export const SCREEN_SNAPSHOT = {
  host: { id: 'host-1', name: 'Host One', endpoint: 'ws://host-1', lastConnected: 3 }
}

const DEFAULT_ROUTE_GRANTS: readonly string[] = [
  'navigate',
  'storage',
  'externalLink',
  'native.clipboard.write'
]

export const SCREEN_BUILD_ID = 'a1b2c3d4e5f6'.repeat(5) + 'abcd'
export const SCREEN_DIRECTORY =
  '/var/mobile/Containers/Data/Caches/mobile-web/deadbeef/generations/a1b2'

// Run from vi.hoisted so __DEV__ is set before import and secret-free developer facts are exercised.
export function createScreenDependencies(): ScreenDependencies {
  Object.assign(globalThis, { __DEV__: true })
  return {
    retry: vi.fn(),
    reportShellFailure: vi.fn(),
    reportDocumentStarted: vi.fn(),
    reportDocumentLoaded: vi.fn(),
    reportPageReady: vi.fn(),
    reportPagePainted: vi.fn(),
    snapshotUnreadable: false,
    storageRefreshes: 0,
    openUrl: vi.fn(),
    push: vi.fn(),
    back: vi.fn(),
    canGoBack: true,
    rootState: undefined,
    dispatch: vi.fn(),
    pathname: '/h/host-1',
    pageRoutes: ['/h/[hostId]'],
    routeGrants: DEFAULT_ROUTE_GRANTS,
    lifecycle: [],
    viewRenders: 0,
    posted: [],
    postFails: false,
    state: { kind: 'checking' },
    downloadProgress: createDownloadProgressFeed(),
    updateNotice: null,
    pageReady: false,
    pageFrame: 'pending',
    client: null,
    keyboardListeners: new Map(),
    backHandlers: new Map(),
    setScreenOptions: vi.fn(),
    backClaimed: false,
    platform: 'ios',
    reportPageBackClaim: vi.fn(),
    sendBackDelivers: true,
    backSends: 0
  }
}

// Reset at file scope: describe blocks share this record and must not inherit prior route grants.
export function resetScreenDependencies(dependencies: ScreenDependencies): void {
  dependencies.retry.mockReset()
  dependencies.reportShellFailure.mockReset()
  dependencies.reportDocumentStarted.mockReset()
  dependencies.reportDocumentLoaded.mockReset()
  dependencies.reportPageReady.mockReset()
  dependencies.reportPagePainted.mockReset()
  dependencies.snapshotUnreadable = false
  dependencies.storageRefreshes = 0
  dependencies.downloadProgress = createDownloadProgressFeed()
  dependencies.lifecycle.length = 0
  dependencies.viewRenders = 0
  dependencies.posted.length = 0
  dependencies.postFails = false
  dependencies.client = null
  dependencies.pageReady = false
  dependencies.pageFrame = 'pending'
  dependencies.routeGrants = DEFAULT_ROUTE_GRANTS
  dependencies.back.mockReset()
  dependencies.openUrl.mockReset()
  dependencies.openUrl.mockImplementation(() => Promise.resolve(true))
  dependencies.canGoBack = true
  dependencies.rootState = undefined
  dependencies.dispatch.mockReset()
  dependencies.pathname = '/h/host-1'
  dependencies.updateNotice = null
  dependencies.backHandlers.clear()
  dependencies.setScreenOptions.mockReset()
  dependencies.reportPageBackClaim.mockReset()
  dependencies.backClaimed = false
  dependencies.platform = 'ios'
  dependencies.sendBackDelivers = true
  dependencies.backSends = 0
}

export function readyState(sessionId: string): MobileWebShellSessionState {
  return {
    kind: 'ready',
    generationDirectory: SCREEN_DIRECTORY,
    sessionId,
    buildId: SCREEN_BUILD_ID,
    totalBytes: 4096,
    elapsedMs: 811
  }
}

// Unmount between cases to release the per-stack pop latch.
const mounted: ReactTestRenderer[] = []

export function trackRenderedScreen(tree: ReactTestRenderer): void {
  mounted.push(tree)
}

export function unmountRenderedScreens(): void {
  act(() => {
    for (const tree of mounted.splice(0)) {
      tree.unmount()
    }
  })
}

// Pass the screen in: importing it from this vi.hoisted dependency would load it before mocks register.
export type ScreenComponent = ComponentType<{
  hostId: string
  route: { pathname: string }
}>

function element(Screen: ScreenComponent): ReactElement {
  return createElement(Screen, {
    hostId: 'host-1',
    route: { pathname: '/h/host-1' }
  })
}

function setScreenState(dependencies: ScreenDependencies, state: MobileWebShellSessionState): void {
  dependencies.state = state
  if (state.kind === 'fetching') {
    dependencies.downloadProgress.publish(downloadFraction(state.receivedBytes, state.totalBytes))
  }
}

export async function renderScreen(
  Screen: ScreenComponent,
  dependencies: ScreenDependencies,
  state: MobileWebShellSessionState
): Promise<ReactTestRenderer> {
  setScreenState(dependencies, state)
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    rendered.tree = create(element(Screen))
  })
  if (rendered.tree === null) {
    throw new Error('screen did not render')
  }
  mounted.push(rendered.tree)
  return rendered.tree
}

export async function updateScreen(
  Screen: ScreenComponent,
  dependencies: ScreenDependencies,
  tree: ReactTestRenderer,
  state: MobileWebShellSessionState
): Promise<void> {
  setScreenState(dependencies, state)
  await act(async () => {
    tree.update(element(Screen))
  })
}

// Match host names by predicate because ElementType excludes arbitrary React Native host strings.
export function byName(tree: ReactTestRenderer, name: string): ReactTestInstance[] {
  return tree.root.findAll((node) => String(node.type) === name)
}

export function hostParentOf(node: ReactTestInstance): string | null {
  let current: ReactTestInstance | null = node.parent
  while (current !== null) {
    if (typeof current.type === 'string') {
      return current.props.testID ?? current.type
    }
    current = current.parent
  }
  return null
}

export function textOf(tree: ReactTestRenderer): string {
  return byName(tree, 'Text')
    .map((node) => node.children.filter((child) => typeof child === 'string').join(''))
    .join('\n')
}
