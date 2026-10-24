import { Buffer } from 'node:buffer'
import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PairConfirmScreen from '../../app/pair-confirm'
import { startPreProfilePairing } from './pre-profile-pairing-coordinator'
import { loadMobileOnboardingSteps } from '../onboarding/mobile-onboarding-plan'

const route = vi.hoisted(() => {
  const state: {
    code: string | string[] | undefined
    router: { replace: ReturnType<typeof vi.fn> }
    refreshHostClient: ReturnType<typeof vi.fn>
  } = {
    code: undefined,
    router: { replace: vi.fn() },
    refreshHostClient: vi.fn()
  }
  return state
})

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles },
  BackHandler: { addEventListener: () => ({ remove() {} }) }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 20 })
}))
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ code: route.code }),
  useRouter: () => route.router,
  useFocusEffect: (callback: () => () => void) => useEffect(callback, [callback])
}))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon' }))
vi.mock('./pre-profile-pairing-coordinator', () => ({ startPreProfilePairing: vi.fn() }))
vi.mock('./host-client-hooks', () => ({
  useRefreshHostClient: () => route.refreshHostClient
}))
vi.mock('../onboarding/mobile-onboarding-plan', () => ({
  loadMobileOnboardingSteps: vi.fn(),
  mobileOnboardingDestination: (_steps: unknown, hostId: string) => `/h/${hostId}`
}))

function offerCode(deviceToken: string): string {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      endpoint: 'ws://192.168.1.10:6768',
      deviceToken,
      publicKeyB64: 'public-key'
    })
  ).toString('base64url')
}

function deferred<T>() {
  let resolve = (_value: T): void => {}
  let reject = (_reason: unknown): void => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

let renderer: ReactTestRenderer | undefined

async function renderCode(code: string | string[] | undefined) {
  route.code = code
  await act(async () => {
    if (renderer) {
      renderer.update(createElement(PairConfirmScreen))
    } else {
      renderer = create(createElement(PairConfirmScreen), { createNodeMock: () => ({}) })
    }
  })
}

async function pressPair() {
  const label = renderer?.root.findAllByProps({ children: 'Pair' })[0]
  if (!label?.parent) {
    throw new Error('Pair button missing')
  }
  await act(async () => {
    label.parent?.props.onPress()
  })
}

function screenText() {
  return JSON.stringify(renderer?.toJSON())
}

beforeEach(() => {
  vi.mocked(loadMobileOnboardingSteps).mockResolvedValue([])
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  vi.resetAllMocks()
})

describe('pair confirmation route ownership', () => {
  it.each(['pairing', 'onboarding'] as const)(
    'honors Back immediately while %s is pending, before navigation detaches the view',
    async (phase) => {
      const pairing = deferred<{ hostId: string }>()
      const onboarding = deferred<[]>()
      const dispose = vi.fn()
      vi.mocked(startPreProfilePairing).mockReturnValue({
        result: pairing.promise,
        timedOut: false,
        dispose
      })
      vi.mocked(loadMobileOnboardingSteps).mockReturnValue(onboarding.promise)
      await renderCode(offerCode('first'))
      await pressPair()
      if (phase === 'onboarding') {
        await act(async () => pairing.resolve({ hostId: 'old-host' }))
      }
      await act(async () =>
        renderer?.root.findByProps({ accessibilityLabel: 'Back' }).props.onPress()
      )
      expect(dispose).toHaveBeenCalled()
      await act(async () => {
        pairing.resolve({ hostId: 'old-host' })
        onboarding.resolve([])
      })
      expect(route.router.replace.mock.calls).toEqual([['/']])
      if (phase === 'pairing') {
        expect(route.refreshHostClient).not.toHaveBeenCalled()
      }
    }
  )

  it('renders recovery for repeated code parameters without starting pairing', async () => {
    await renderCode([offerCode('first'), offerCode('second')])
    expect(screenText()).toContain('Not a valid pairing code')
    expect(screenText()).toContain('Back to home')
    expect(startPreProfilePairing).not.toHaveBeenCalled()
  })

  it('disposes the replaced offer and ignores its late logs and completion', async () => {
    const pending = deferred<{ hostId: string }>()
    const dispose = vi.fn()
    vi.mocked(startPreProfilePairing).mockReturnValue({
      result: pending.promise,
      timedOut: false,
      dispose
    })
    await renderCode(offerCode('first'))
    await pressPair()
    const onLog = vi.mocked(startPreProfilePairing).mock.calls[0]?.[0].connectOptions?.onLog
    expect(screenText()).toContain('Connecting…')
    await act(async () => {
      onLog?.({ id: 'old', ts: 0, level: 'info', message: 'previous-offer-log' })
    })
    expect(screenText()).toContain('previous-offer-log')

    await renderCode(offerCode('second'))
    expect(dispose).toHaveBeenCalled()
    expect(screenText()).toContain('Pair with this desktop?')
    expect(screenText()).not.toContain('previous-offer-log')
    await act(async () => {
      onLog?.({ id: 'stale', ts: 0, level: 'error', message: 'old-offer-log' })
      pending.resolve({ hostId: 'old-host' })
    })
    expect(screenText()).not.toContain('old-offer-log')
    expect(route.router.replace).not.toHaveBeenCalled()
    expect(route.refreshHostClient).not.toHaveBeenCalled()

    const next = deferred<{ hostId: string }>()
    vi.mocked(startPreProfilePairing).mockReturnValue({
      result: next.promise,
      timedOut: false,
      dispose: vi.fn()
    })
    await pressPair()
    expect(vi.mocked(startPreProfilePairing).mock.calls[1]?.[0].offer.deviceToken).toBe('second')
    await act(async () => {
      next.resolve({ hostId: 'new-host' })
    })
    expect(route.router.replace).toHaveBeenCalledWith('/h/new-host')
  })

  it('clears a failed offer when a new pairing code arrives', async () => {
    const pending = deferred<{ hostId: string }>()
    vi.mocked(startPreProfilePairing).mockReturnValue({
      result: pending.promise,
      timedOut: false,
      dispose: vi.fn()
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await renderCode(offerCode('first'))
    await pressPair()
    await act(async () => {
      pending.reject(new Error('unreachable desktop'))
    })
    expect(screenText()).toContain('unreachable desktop')

    await renderCode(offerCode('second'))
    expect(screenText()).toContain('Pair with this desktop?')
    expect(screenText()).not.toContain('unreachable desktop')
    vi.mocked(console.warn).mockRestore()
  })

  it('does not navigate to an old host when onboarding resolves after replacement', async () => {
    const onboarding = deferred<[]>()
    vi.mocked(loadMobileOnboardingSteps).mockReturnValue(onboarding.promise)
    vi.mocked(startPreProfilePairing).mockReturnValue({
      result: Promise.resolve({ hostId: 'old-host' }),
      timedOut: false,
      dispose: vi.fn()
    })
    await renderCode(offerCode('first'))
    await pressPair()
    expect(loadMobileOnboardingSteps).toHaveBeenCalled()
    await renderCode(offerCode('second'))
    await act(async () => {
      onboarding.resolve([])
    })
    expect(route.router.replace).not.toHaveBeenCalled()
    expect(screenText()).toContain('Pair with this desktop?')
  })

  it('keeps a pending attempt across rerenders of the same code', async () => {
    const pending = deferred<{ hostId: string }>()
    const dispose = vi.fn()
    vi.mocked(startPreProfilePairing).mockReturnValue({
      result: pending.promise,
      timedOut: false,
      dispose
    })
    await renderCode(offerCode('first'))
    await pressPair()
    await renderCode(offerCode('first'))
    expect(dispose).not.toHaveBeenCalled()
    expect(screenText()).toContain('Connecting…')
    await act(async () => {
      pending.resolve({ hostId: 'same-host' })
    })
    expect(route.router.replace).toHaveBeenCalledWith('/h/same-host')
  })
})
