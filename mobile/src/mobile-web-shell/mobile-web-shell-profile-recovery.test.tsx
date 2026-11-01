import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const harness = await vi.hoisted(async () => await import('./mobile-web-shell-screen-test-harness'))
const dependencies = vi.hoisted(() => harness.createScreenDependencies())

const { screenModuleMocks } = await vi.hoisted(
  async () => await import('./mobile-web-shell-screen-test-mocks')
)
const mocks = vi.hoisted(() => screenModuleMocks(dependencies))
vi.mock('react-native', () => ({
  ...mocks['react-native'](),
  useWindowDimensions: () => ({ width: profile.wide ? 1200 : 390, height: 844 })
}))
vi.mock('expo-clipboard', mocks['expo-clipboard'])
vi.mock('expo-haptics', mocks['expo-haptics'])
vi.mock('expo-document-picker', mocks['expo-document-picker'])
vi.mock('@orca/expo-two-way-audio', mocks['@orca/expo-two-way-audio'])
vi.mock('expo-keep-awake', mocks['expo-keep-awake'])
vi.mock('expo-image-picker', mocks['expo-image-picker'])
vi.mock('expo-file-system', mocks['expo-file-system'])
vi.mock('lucide-react-native', mocks['lucide-react-native'])
vi.mock('react-native-safe-area-context', mocks['react-native-safe-area-context'])
vi.mock('expo-router', mocks['expo-router'])
vi.mock('../../modules/orca-mobile-web-shell/src', mocks['../../modules/orca-mobile-web-shell/src'])
vi.mock('../app-update/use-wall-app-update', mocks['../app-update/use-wall-app-update'])
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({ client: dependencies.client, state: 'connected' })
}))

const profile = vi.hoisted(() => ({
  fails: true,
  reads: 0,
  downloads: 0,
  wide: false,
  hold: false,
  canOwnHostArea: false,
  release: (): void => {}
}))
vi.mock('../transport/host-store', () => ({
  loadHosts: async () => {
    profile.reads += 1
    if (profile.hold) {
      await new Promise<void>((resolve) => {
        profile.release = resolve
      })
    }
    if (profile.fails) {
      throw new Error('the keychain is temporarily unavailable')
    }
    return [{ id: 'host-1', name: 'Host One', endpoint: 'ws://host-1', lastConnected: 3 }]
  }
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    multiGet: async () => [],
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined
  }
}))
vi.mock('../components/host-protocol-gates-context', () => ({
  useHostProtocolGates: () => ({
    statusPending: false,
    statusReadable: true,
    hostCapabilities: [MOBILE_WEB_BUNDLE_CAPABILITY],
    hostProtocolWindow: { protocolVersion: 10, minCompatibleMobileVersion: 1 }
  })
}))
vi.mock('../transport/rpc-operation', async (importOriginal) => ({
  ...(await importOriginal<typeof RpcOperationModule>()),
  runRpcOperation: async () => ({ manifest: currentManifest() })
}))
vi.mock('../transport/mobile-web-bundle-fetch', () => ({
  fetchMobileWebBundle: async () => {
    profile.downloads += 1
    return {
      manifest: currentManifest(),
      assets: new Map(),
      reused: [],
      totalBytes: 4096,
      elapsedMs: 0
    }
  }
}))

import type * as RpcOperationModule from '../transport/rpc-operation'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import { MobileWebShellScreen } from './MobileWebShellScreen'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { byName, trackRenderedScreen, textOf } from './mobile-web-shell-screen-test-harness'
import { MANIFEST_WIRE } from './mobile-web-shell-session-test-fixtures'
import { readBridgeHostMessage } from './bridge/bridge-envelope'
import type { ActiveGeneration, GenerationStore } from './generation-store'

afterEach(harness.unmountRenderedScreens)
beforeEach(() => {
  harness.resetScreenDependencies(dependencies)
  profile.fails = true
  profile.reads = 0
  profile.downloads = 0
  profile.wide = false
  profile.hold = false
  profile.canOwnHostArea = false
})

function currentManifest() {
  return profile.canOwnHostArea
    ? {
        ...MANIFEST_WIRE,
        routes: [{ pathname: '/h/[hostId]', grants: ['navigate'], canOwnHostArea: true }]
      }
    : MANIFEST_WIRE
}

function cachedStore() {
  const active = {
    buildId: MANIFEST_WIRE.buildId,
    directory: 'file:///cache/generation',
    manifest: currentManifest()
  }
  let cached: ActiveGeneration | null = active
  const heldReads: (() => void)[] = []
  const cache = {
    holdReads: false,
    releaseReads: () => {
      for (const release of heldReads.splice(0)) {
        release()
      }
    },
    deletes: vi.fn(async () => {
      cached = null
    })
  }
  const store: GenerationStore = {
    readActiveGeneration: async () => {
      const answer = cached
      if (cache.holdReads) {
        await new Promise<void>((resolve) => heldReads.push(resolve))
      }
      return answer
    },
    openReusableAssets: async () => ({ has: () => false, check: async () => false }),
    stageGeneration: async () => ({ ...active, hostKey: 'host-key' }),
    commitGeneration: async () => {
      cached = active
      return active
    },
    abortStagedGeneration: async () => undefined,
    sweepStagedGenerations: async () => undefined,
    deleteHostCache: cache.deletes,
    recordUpdateFailure: async () => undefined,
    readUpdateFailures: async () => [],
    forgetHostUpdateFailures: async () => undefined
  }
  return Object.assign(cache, { store })
}

async function mount(cache: ReturnType<typeof cachedStore>) {
  dependencies.client = createFakeRpcClient()
  const timers: { run: () => void; cancelled: boolean }[] = []
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    rendered.tree = create(
      createElement(MobileWebShellScreen, {
        hostId: 'host-1',
        route: { pathname: '/h/host-1' },
        runtime: {
          createStore: () => cache.store,
          mintSessionId: () => 'session-one',
          now: () => 0,
          setTimer: (run) => {
            const timer = { run, cancelled: false }
            timers.push(timer)
            return () => {
              timer.cancelled = true
            }
          }
        }
      })
    )
    trackRenderedScreen(rendered.tree)
  })
  const tree = rendered.tree
  if (tree === null) {
    throw new Error('the screen did not mount')
  }
  return { tree, timers }
}

async function retryWithReadableProfile(tree: ReactTestRenderer): Promise<void> {
  profile.fails = false
  const retry = tree.root.find(
    (node) => node.props.testID === 'mobile-web-shell-retry' && String(node.type) === 'Pressable'
  )
  await act(async () => {
    retry.props.onPress()
  })
  expect(profile.reads).toBe(2)
  await act(async () => {
    byName(tree, 'ShellViewProbe')[0].props.onBridgeMessage({
      nativeEvent: { json: clientFrame({ type: 'ready' }) }
    })
  })
  const inits = dependencies.posted.flatMap((json) => {
    const frame = readBridgeHostMessage(json)
    return frame.ok && frame.message.type === 'init' ? [frame.message] : []
  })
  expect(inits).toHaveLength(1)
  expect(inits[0]?.host?.id).toBe('host-1')
  expect(inits[0]?.ownsHostArea).toBeUndefined()
}

it('retries an unavailable device profile without deleting or downloading verified bytes', async () => {
  const cache = cachedStore()
  const { tree, timers } = await mount(cache)
  expect(cache.deletes).not.toHaveBeenCalled()
  expect(profile.downloads).toBe(0)
  expect(textOf(tree)).toContain('Could not read this host on your device')
  expect(byName(tree, 'ShellViewProbe')).toHaveLength(0)
  expect(timers.every((timer) => timer.cancelled)).toBe(true)
  await retryWithReadableProfile(tree)
  expect(cache.deletes).not.toHaveBeenCalled()
  expect(profile.downloads).toBe(0)
})

it('ends checking on profile failure and ignores cache work completed after that failure', async () => {
  const cache = cachedStore()
  cache.holdReads = true
  const { tree } = await mount(cache)
  expect(textOf(tree)).toContain('Could not read this host on your device')
  await act(async () => {
    cache.releaseReads()
  })
  expect(textOf(tree)).toContain('Could not read this host on your device')
  expect(byName(tree, 'ShellViewProbe')).toHaveLength(0)
  cache.holdReads = false
  await retryWithReadableProfile(tree)
  expect(profile.downloads).toBe(0)
})

it('keeps profile failure parked across layout changes and retries with the latest layout', async () => {
  profile.wide = true
  profile.hold = true
  profile.canOwnHostArea = true
  const cache = cachedStore()
  const { tree } = await mount(cache)
  expect(byName(tree, 'ShellViewProbe')).toHaveLength(1)
  await act(async () => {
    profile.release()
  })
  expect(textOf(tree)).toContain('Could not read this host on your device')
  for (const wide of [false, true, false]) {
    profile.wide = wide
    await act(async () => {
      tree.update(
        createElement(MobileWebShellScreen, {
          hostId: 'host-1',
          route: { pathname: '/h/host-1' }
        })
      )
    })
    expect(textOf(tree)).toContain('Could not read this host on your device')
    expect(byName(tree, 'ShellViewProbe')).toHaveLength(0)
    expect(profile.reads).toBe(1)
  }
  profile.hold = false
  await retryWithReadableProfile(tree)
  expect(cache.deletes).not.toHaveBeenCalled()
  expect(profile.downloads).toBe(0)
})
