import { createElement, memo, useEffect } from 'react'
import type { LucideProps } from 'lucide-react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeReviewStatus } from '../../../src/shared/worktree-review-status'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { ConnectionState } from '../transport/types'
import { applyMobileColorScheme, colors } from '../theme/mobile-theme'
import { MobileSourceControlButton } from './MobileSourceControlButton'

const lifecycle = vi.hoisted(() => ({
  state: 'active',
  focused: true,
  supported: true,
  appListeners: new Set<(state: string) => void>(),
  focusListeners: new Set<() => void>(),
  iconRenders: 0
}))
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  AppState: {
    get currentState() {
      return lifecycle.state
    },
    addEventListener: (_name: string, listener: (state: string) => void) => {
      lifecycle.appListeners.add(listener)
      return { remove: () => lifecycle.appListeners.delete(listener) }
    }
  }
}))
vi.mock('./mobile-session-styles', () => ({
  styles: {
    headerButton: { width: 36 },
    headerButtonActive: { backgroundColor: 'active' }
  }
}))
vi.mock('../transport/use-workspace-client', () => ({
  useRouteCapability: () => lifecycle.supported
}))
vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect(effect: () => void | (() => void)) {
      const focused = React.useSyncExternalStore(
        (notify) => {
          lifecycle.focusListeners.add(notify)
          return () => {
            lifecycle.focusListeners.delete(notify)
          }
        },
        () => lifecycle.focused
      )
      React.useEffect(() => (focused ? effect() : undefined), [effect, focused])
    }
  }
})
vi.mock('lucide-react-native', async () => {
  const { createElement } = await import('react')
  return Object.fromEntries(
    ['GitBranch', 'GitMerge', 'GitPullRequest', 'GitPullRequestClosed', 'GitPullRequestDraft'].map(
      (name) => [
        name,
        (props: LucideProps) => {
          lifecycle.iconRenders++
          return createElement(name, props)
        }
      ]
    )
  )
})

let renderer: ReactTestRenderer | undefined
let frames: ((value: unknown) => void)[]
let connectionListeners: Set<() => void>
let connection: ConnectionState
let chatMounts: number
const sendRequest = vi.fn()
const stopStream = vi.fn()
const onPress = vi.fn()
const subscribe = vi.fn((_method: string, _params: unknown, listener: (value: unknown) => void) => {
  frames.push(listener)
  return stopStream
})
const client = stubRpcClient({
  subscribe,
  sendRequest,
  getState: () => connection,
  onStateChange: (listener) => {
    const notify = () => listener(connection)
    connectionListeners.add(notify)
    return () => {
      connectionListeners.delete(notify)
    }
  }
})
const Chat = memo(function Chat() {
  useEffect(() => {
    chatMounts++
  }, [])
  return createElement('Chat')
})
function Harness({ enabled = true, worktreeId = 'repo::/worktree', tick = 0 } = {}) {
  return createElement(
    'Session',
    { tick },
    createElement(MobileSourceControlButton, {
      client,
      worktreeId,
      enabled,
      active: false,
      onPress
    }),
    createElement(Chat)
  )
}
function mount(props = {}) {
  act(() => {
    renderer = create(createElement(Harness, props))
  })
}
function update(props = {}) {
  act(() => {
    renderer?.update(createElement(Harness, props))
  })
}
function frame(overrides: Partial<WorktreeReviewStatus> = {}): WorktreeReviewStatus {
  return {
    type: 'snapshot',
    subscriptionId: 'lease-1',
    worktreeId: 'repo::/worktree',
    branch: 'feature',
    fetchedAt: 1,
    stale: false,
    review: {
      number: 42,
      state: 'open',
      checksStatus: 'success',
      title: 'Feature',
      url: 'https://github.com/a/b/pull/42'
    },
    ...overrides
  }
}
function emit(value: unknown) {
  act(() => {
    frames.at(-1)?.(value)
  })
}
function appState(state: string) {
  act(() => {
    lifecycle.state = state
    lifecycle.appListeners.forEach((listener) => listener(state))
  })
}
function connect(state: ConnectionState) {
  act(() => {
    connection = state
    connectionListeners.forEach((listener) => listener())
  })
}
function button() {
  return renderer!.root.find((node) => String(node.type) === 'Pressable')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  lifecycle.state = 'active'
  lifecycle.focused = true
  lifecycle.supported = true
  lifecycle.iconRenders = 0
  lifecycle.appListeners.clear()
  frames = []
  connectionListeners = new Set()
  connection = 'connected'
  chatMounts = 0
  sendRequest.mockResolvedValue({
    id: 'reply',
    ok: true,
    result: { renewed: true, unsubscribed: true }
  })
  applyMobileColorScheme('dark')
})
afterEach(() => {
  act(() => {
    renderer?.unmount()
  })
  renderer = undefined
  vi.useRealTimers()
})

describe('mobile source-control review status', () => {
  it.each([
    ['open', 'failure', 'GitPullRequest', 'statusRed', 'failing'],
    ['open', 'pending', 'GitPullRequest', 'statusAmber', 'pending'],
    ['open', 'success', 'GitPullRequest', 'statusGreen', 'passing'],
    ['open', 'neutral', 'GitPullRequest', 'statusGreen', 'Open pull request'],
    ['merged', 'failure', 'GitMerge', 'statusPurple', 'Merged'],
    ['draft', 'failure', 'GitPullRequestDraft', 'textMuted', 'Draft'],
    ['closed', 'pending', 'GitPullRequestClosed', 'textMuted', 'Closed']
  ] as const)(
    'renders %s/%s with the shared status label and whole icon stroke',
    (state, checksStatus, glyph, tone, label) => {
      mount()
      const initial = frame()
      emit({ ...initial, review: { ...initial.review!, state, checksStatus } })
      expect(button().props.accessibilityLabel).toContain(label)
      expect(renderer!.root.find((node) => String(node.type) === glyph).props.color).toBe(
        colors[tone]
      )
      expect(button().props.hitSlop).toBe(4)
      act(() => button().props.onPress())
      expect(onPress).toHaveBeenCalledOnce()
    }
  )

  it('keeps unknown and absent reviews neutral without claiming checks passed', () => {
    mount()
    expect(button().props.accessibilityLabel).toContain('unknown')
    expect(renderer!.root.find((node) => String(node.type) === 'GitBranch').props.color).toBe(
      colors.textSecondary
    )
    emit(frame({ review: null }))
    expect(button().props.accessibilityLabel).toContain('No pull request')
    expect(renderer!.root.find((node) => String(node.type) === 'GitBranch').props.color).toBe(
      colors.textSecondary
    )
    emit({ ...frame(), review: { state: 'unknown', checksStatus: 'success' } })
    expect(button().props.accessibilityLabel).not.toContain('passing')
  })

  it('does no icon work for repeated payloads, timestamps or streaming chat, and real changes preserve chat', () => {
    mount()
    emit(frame())
    const renders = lifecycle.iconRenders
    for (let i = 0; i < 10; i++) {
      emit(frame({ type: 'updated', fetchedAt: i + 2 }))
      update({ tick: i })
    }
    expect(lifecycle.iconRenders).toBe(renders)
    expect(chatMounts).toBe(1)
    emit(frame({ review: { ...frame().review!, checksStatus: 'failure' } }))
    expect(lifecycle.iconRenders).toBe(renders + 1)
    expect(chatMounts).toBe(1)
    expect(subscribe).toHaveBeenCalledOnce()
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('renews only the focused foreground lease and releases it on background, disconnect and route leave', async () => {
    mount()
    emit(frame())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50_000)
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'worktree.review.renew',
      { subscriptionId: 'lease-1' },
      { failWhenDisconnected: true }
    )
    appState('background')
    expect(stopStream).toHaveBeenCalledTimes(1)
    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual(['worktree.review.renew'])
    const calls = sendRequest.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000)
    })
    expect(sendRequest).toHaveBeenCalledTimes(calls)
    appState('active')
    expect(subscribe).toHaveBeenCalledTimes(2)
    emit(frame({ subscriptionId: 'lease-2' }))
    connect('disconnected')
    expect(stopStream).toHaveBeenCalledTimes(2)
    connect('connected')
    expect(subscribe).toHaveBeenCalledTimes(3)
    connect('connected')
    expect(subscribe).toHaveBeenCalledTimes(3)
    emit(frame({ subscriptionId: 'lease-3' }))
    act(() => {
      lifecycle.focused = false
      lifecycle.focusListeners.forEach((listener) => listener())
    })
    expect(stopStream).toHaveBeenCalledTimes(3)
    expect(connectionListeners.size).toBe(0)
    expect(lifecycle.appListeners.size).toBe(0)
  })

  it('keeps an unresolved null review unknown until the host confirms absence', () => {
    mount()
    emit(frame({ review: null, fetchedAt: null, stale: true }))
    expect(button().props.accessibilityLabel).toContain('unknown')
    emit(frame({ review: null, error: 'lookup failed' }))
    expect(button().props.accessibilityLabel).toContain('unknown')
    emit(frame({ review: null, fetchedAt: 2, stale: false }))
    expect(button().props.accessibilityLabel).toContain('No pull request')
  })

  it.each([{ stale: true }, { error: 'refresh failed' }, { fetchedAt: null }])(
    'identifies a known cached PR accessibly until fresh status arrives: %j',
    (metadata) => {
      mount()
      emit(frame(metadata))
      expect(button().props.accessibilityLabel).toBe(
        'Open source control, Open pull request, checks passing, cached status'
      )
      expect(
        renderer!.root.find((node) => String(node.type) === 'GitPullRequest').props.color
      ).toBe(colors.statusGreen)
      const renders = lifecycle.iconRenders
      emit(frame({ ...metadata, type: 'updated' }))
      expect(lifecycle.iconRenders).toBe(renders)
      emit(frame({ fetchedAt: 2 }))
      expect(button().props.accessibilityLabel).toBe(
        'Open source control, Open pull request, checks passing'
      )
      expect(lifecycle.iconRenders).toBe(renders + 1)
      expect(chatMounts).toBe(1)
    }
  )

  it('ignores old route frames and renewal completion after switching workspaces', async () => {
    mount()
    emit(frame())
    let finishRenew: ((value: unknown) => void) | undefined
    sendRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRenew = resolve
        })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50_000)
    })
    const oldFrame = frames[0]
    update({ worktreeId: 'repo::/next' })
    expect(button().props.accessibilityLabel).toContain('unknown')
    emit(
      frame({
        worktreeId: 'repo::/next',
        subscriptionId: 'next-lease',
        review: { ...frame().review!, state: 'merged' }
      })
    )
    await act(async () => {
      finishRenew?.({ id: 'late', ok: true, result: { renewed: false } })
      oldFrame?.(frame())
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(button().props.accessibilityLabel).toContain('Merged')
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(chatMounts).toBe(1)
    expect(stopStream).toHaveBeenCalledOnce()
  })

  it('ignores old-host cache replies delivered after switching workspaces', async () => {
    lifecycle.supported = false
    let finishCache: ((value: unknown) => void) | undefined
    sendRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCache = resolve
        })
    )
    mount()
    await act(async () => {
      update({ worktreeId: 'repo::/next' })
    })
    await act(async () => {
      finishCache?.({
        id: 'late-cache',
        ok: true,
        result: { worktrees: [{ worktreeId: 'repo::/worktree', linkedPR: { state: 'merged' } }] }
      })
    })
    expect(button().props.accessibilityLabel).toContain('unknown')
    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual(['worktree.ps', 'worktree.ps'])
    expect(subscribe).not.toHaveBeenCalled()
    expect(chatMounts).toBe(1)
  })

  describe.each([
    {
      name: 'confirmed absence',
      review: null,
      freshLabel: 'No pull request',
      recoveredLabel: 'Pull request status unknown',
      glyph: 'GitBranch',
      tone: 'textSecondary'
    },
    {
      name: 'known passing PR',
      review: frame().review,
      freshLabel: 'Open pull request, checks passing',
      recoveredLabel: 'Open pull request, checks passing, cached status',
      glyph: 'GitPullRequest',
      tone: 'statusGreen'
    }
  ] as const)('$name recovery', ({ review, freshLabel, recoveredLabel, glyph, tone }) => {
    it.each(['error', 'end', 'renewal refused', 'renewal rejected'] as const)(
      'invalidates freshness after %s and restores it only after new data',
      async (failure) => {
        mount()
        emit(frame({ review }))
        expect(button().props.accessibilityLabel).toBe(`Open source control, ${freshLabel}`)
        const freshRenders = lifecycle.iconRenders
        if (failure === 'error' || failure === 'end') {
          emit({ type: failure, message: 'stream unavailable' })
        } else {
          if (failure === 'renewal refused') {
            sendRequest.mockResolvedValueOnce({
              id: 'expired',
              ok: true,
              result: { renewed: false }
            })
          } else {
            sendRequest.mockRejectedValueOnce(new Error('renewal unavailable'))
          }
          await act(async () => {
            await vi.advanceTimersByTimeAsync(50_000)
          })
        }
        expect(button().props.accessibilityLabel).toBe(`Open source control, ${recoveredLabel}`)
        expect(renderer!.root.find((node) => String(node.type) === glyph).props.color).toBe(
          colors[tone]
        )
        expect(lifecycle.iconRenders).toBe(freshRenders + 1)
        expect(stopStream).toHaveBeenCalledOnce()
        expect(subscribe).toHaveBeenCalledOnce()

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000)
        })
        expect(subscribe).toHaveBeenCalledTimes(2)
        // A silent replacement must neither restore freshness nor repeat the qualifier.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000)
        })
        expect(button().props.accessibilityLabel).toBe(`Open source control, ${recoveredLabel}`)
        expect(lifecycle.iconRenders).toBe(freshRenders + 1)
        expect(stopStream).toHaveBeenCalledTimes(2)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000)
        })
        expect(subscribe).toHaveBeenCalledTimes(3)
        emit(frame({ review, subscriptionId: 'fresh-lease', fetchedAt: 2 }))
        expect(button().props.accessibilityLabel).toBe(`Open source control, ${freshLabel}`)
        expect(lifecycle.iconRenders).toBe(freshRenders + 2)
        emit(frame({ review, subscriptionId: 'fresh-lease', fetchedAt: 3 }))
        expect(lifecycle.iconRenders).toBe(freshRenders + 2)
        expect(sendRequest.mock.calls.map(([method]) => method)).toEqual(
          failure === 'error' || failure === 'end' ? [] : ['worktree.review.renew']
        )
        expect(chatMounts).toBe(1)
      }
    )
  })

  it('recovers expired leases and stream errors with one bounded subscription retry', async () => {
    mount()
    emit(frame())
    sendRequest.mockResolvedValueOnce({ id: 'expired', ok: true, result: { renewed: false } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50_000)
    })
    expect(stopStream).toHaveBeenCalledOnce()
    expect(subscribe).toHaveBeenCalledOnce()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(subscribe).toHaveBeenCalledTimes(2)
    emit(frame({ subscriptionId: 'lease-2' }))
    emit({ type: 'error', message: 'stream failed' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(subscribe).toHaveBeenCalledTimes(3)
    expect(
      sendRequest.mock.calls.every(([method]) => String(method).startsWith('worktree.review.'))
    ).toBe(true)
    appState('background')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(subscribe).toHaveBeenCalledTimes(3)
  })

  it('ignores a disposed stream and late rejected renewal after the next foreground lease', async () => {
    mount()
    emit(frame())
    let rejectRenew: ((error: Error) => void) | undefined
    sendRequest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRenew = reject
        })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50_000)
    })
    const oldFrame = frames[0]
    appState('background')
    appState('active')
    emit(frame({ subscriptionId: 'lease-2', review: { ...frame().review!, state: 'merged' } }))
    await act(async () => {
      rejectRenew?.(new Error('old request failed'))
      oldFrame?.(frame({ review: { ...frame().review!, checksStatus: 'failure' } }))
    })
    expect(renderer!.root.find((node) => String(node.type) === 'GitMerge').props.color).toBe(
      colors.statusPurple
    )
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(chatMounts).toBe(1)
  })

  it('never opens review work for ineligible routes or a session starting in background', () => {
    mount({ enabled: false })
    expect(subscribe).not.toHaveBeenCalled()
    expect(sendRequest).not.toHaveBeenCalled()
    lifecycle.state = 'background'
    update({ enabled: true })
    expect(subscribe).not.toHaveBeenCalled()
    appState('active')
    expect(subscribe).toHaveBeenCalledOnce()
  })

  it('reads only cached summary once for an old host and once after reconnect, with no polling', async () => {
    lifecycle.supported = false
    sendRequest.mockResolvedValue({
      id: 'cache',
      ok: true,
      result: {
        worktrees: [
          { worktreeId: 'repo::/worktree', linkedPR: { state: 'merged', checksStatus: 'failure' } }
        ]
      }
    })
    await act(async () => {
      mount()
    })
    expect(renderer!.root.find((node) => String(node.type) === 'GitMerge').props.color).toBe(
      colors.statusPurple
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000)
    })
    update({ tick: 1 })
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenCalledWith('worktree.ps', {})
    expect(button().props.accessibilityLabel).toContain('cached status')
    connect('disconnected')
    sendRequest.mockResolvedValueOnce({
      id: 'empty-cache',
      ok: true,
      result: {
        worktrees: [{ worktreeId: 'repo::/worktree', linkedPR: null }]
      }
    })
    await act(async () => {
      connect('connected')
    })
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(button().props.accessibilityLabel).toContain('unknown')
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('updates native theme tokens for light and dark without changing the neutral button surface', () => {
    mount()
    emit(frame())
    const surface = button().props.style({ pressed: false })
    act(() => applyMobileColorScheme('light'))
    expect(renderer!.root.find((node) => String(node.type) === 'GitPullRequest').props.color).toBe(
      colors.statusGreen
    )
    expect(button().props.style({ pressed: false })).toEqual(surface)
    act(() => applyMobileColorScheme('dark'))
    expect(renderer!.root.find((node) => String(node.type) === 'GitPullRequest').props.color).toBe(
      colors.statusGreen
    )
  })
})
