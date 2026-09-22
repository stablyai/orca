import { createElement, type ComponentType, type ReactElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { vi, type Mock } from 'vitest'
import type { FakeRpcClient } from './bridge-host-test-fakes'
import type {
  MobileWebShellSessionState,
  MobileWebShellUpdateNotice
} from './mobile-web-shell-session-contract'
import type { ShellPageFrame } from './shell-page-frame'

/**
 * Everything the screen's cases mock away, as one mutable record, plus the helpers that mount it.
 * Separate from the cases because the `vi.mock` factories that read it must stay in the test file
 * while nothing else here has to, and the file was over `max-lines` with both.
 */
export type ScreenDependencies = {
  retry: Mock
  reportShellFailure: Mock
  reportDocumentStarted: Mock
  reportDocumentLoaded: Mock
  reportPageReady: Mock
  reportPagePainted: Mock
  /** The profile read rejected, which is the one state that has no host to build against. */
  snapshotUnreadable: boolean
  storageRefreshes: number
  openUrl: Mock
  push: Mock
  back: Mock
  /** What the native stack answers: false is a page opened as the first screen on it. */
  canGoBack: boolean
  pathname: string
  pageRoutes: readonly string[]
  routeGrants: readonly string[]
  lifecycle: string[]
  /** Every render of the shell view, which is one per render of the screen above it. */
  viewRenders: number
  /** Every frame the shell posted to the page, raw. */
  posted: string[]
  /** Whether the view refuses what it is handed, which is a page the post never reached. */
  postFails: boolean
  state: MobileWebShellSessionState
  /** Non-null when the generation on screen is a fallback from an update the shell refused. */
  updateNotice: MobileWebShellUpdateNotice | null
  /** What the session reducer says about the page's handshake; true only for the fence's case. */
  pageReady: boolean
  /** How far the document on screen has got, which is what decides whether the cover is up. */
  pageFrame: ShellPageFrame
  /** Null for every case but the bridge's: with no client the hook builds no host at all. */
  client: FakeRpcClient | null
  /** The IME events the app's own keyboard seam subscribes to, by name. */
  keyboardListeners: Map<string, (event: { endCoordinates: { height: number } }) => void>
  /** The device-key listeners the screen registered, by name. Empty unless the page claims Back. */
  backHandlers: Map<string, () => boolean>
  /** Every option patch the screen wrote onto its own place on the stack, in order. */
  setScreenOptions: Mock
  /** Whether the session says the page is holding the device Back key. */
  backClaimed: boolean
  reportPageBackClaim: Mock
  /** Whether the mounted host would take a press, which is a page that declared it takes one. */
  sendBackDelivers: boolean
  /** One entry per press the screen handed to the host. */
  backSends: number
}

export const SCREEN_SNAPSHOT = {
  host: { id: 'host-1', name: 'Host One', endpoint: 'ws://host-1', lastConnected: 3 }
}

export const DEFAULT_ROUTE_GRANTS: readonly string[] = [
  'navigate',
  'storage',
  'externalLink',
  'native.clipboard.write'
]

export const SCREEN_BUILD_ID = 'a1b2c3d4e5f6'.repeat(5) + 'abcd'
export const SCREEN_DIRECTORY =
  '/var/mobile/Containers/Data/Caches/mobile-web/deadbeef/generations/a1b2'

/** Called from the test file's `vi.hoisted`, so `__DEV__` is on before the screen is imported and
 *  the developer facts are reachable at all — they are the one thing that must never grow a secret. */
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
    pathname: '/h/host-1',
    pageRoutes: ['/h/[hostId]'],
    routeGrants: DEFAULT_ROUTE_GRANTS,
    lifecycle: [],
    viewRenders: 0,
    posted: [],
    postFails: false,
    state: { kind: 'checking' },
    updateNotice: null,
    pageReady: false,
    pageFrame: 'pending',
    client: null,
    keyboardListeners: new Map(),
    backHandlers: new Map(),
    setScreenOptions: vi.fn(),
    backClaimed: false,
    reportPageBackClaim: vi.fn(),
    sendBackDelivers: true,
    backSends: 0
  }
}

/**
 * File-level, not per describe: every block shares one mutable record, so a reset scoped to one of
 * them leaves whatever the others set. `routeGrants` is reset for that reason — a case that grants
 * the screencast lane would otherwise hand it to every case that follows.
 */
export function resetScreenDependencies(dependencies: ScreenDependencies): void {
  dependencies.retry.mockReset()
  dependencies.reportShellFailure.mockReset()
  dependencies.reportDocumentStarted.mockReset()
  dependencies.reportDocumentLoaded.mockReset()
  dependencies.reportPageReady.mockReset()
  dependencies.reportPagePainted.mockReset()
  dependencies.snapshotUnreadable = false
  dependencies.storageRefreshes = 0
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
  dependencies.pathname = '/h/host-1'
  dependencies.updateNotice = null
  dependencies.backHandlers.clear()
  dependencies.setScreenOptions.mockReset()
  dependencies.reportPageBackClaim.mockReset()
  dependencies.backClaimed = false
  dependencies.sendBackDelivers = true
  dependencies.backSends = 0
}

/** The caller's native screen, as a component so `findAllByType` can name it without a host string. */
export function NativeFallback(): null {
  return null
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

/** Unmounted between cases: the shell's stack latch is one per stack, so a screen left mounted is
 *  a screen still holding whatever pop it took. */
const mounted: ReactTestRenderer[] = []

/** Registers a tree the caller mounted itself, so the teardown below reaches it too. */
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

/**
 * The screen is passed in rather than imported: this module is loaded from `vi.hoisted`, before the
 * mocks are registered, so importing the module under test here would load it unmocked.
 */
export type ScreenComponent = ComponentType<{
  hostId: string
  route: { pathname: string }
  fallback: ReactElement
}>

function element(Screen: ScreenComponent): ReactElement {
  return createElement(Screen, {
    hostId: 'host-1',
    route: { pathname: '/h/host-1' },
    fallback: createElement(NativeFallback)
  })
}

export async function renderScreen(
  Screen: ScreenComponent,
  dependencies: ScreenDependencies,
  state: MobileWebShellSessionState
): Promise<ReactTestRenderer> {
  dependencies.state = state
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
  dependencies.state = state
  await act(async () => {
    tree.update(element(Screen))
  })
}

/** Host elements are matched by name, not by `findAllByType`: React's `ElementType` does not admit
 *  an arbitrary React Native host name, so the typed form is a predicate. */
export function byName(tree: ReactTestRenderer, name: string): ReactTestInstance[] {
  return tree.root.findAll((node) => String(node.type) === name)
}

/** The nearest laid-out ancestor of a node, which is the box its own box is measured against. */
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
