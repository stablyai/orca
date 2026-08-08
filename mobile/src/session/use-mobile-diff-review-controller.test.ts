import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import { useMobileDiffReviewController } from './use-mobile-diff-review-controller'

const loadSnapshot = vi.hoisted(() => vi.fn())
vi.mock('./mobile-diff-review-loaders', () => ({
  loadMobileDiffReviewSnapshot: loadSnapshot,
  loadMobileDiffReviewDiff: vi.fn().mockResolvedValue({ kind: 'idle' })
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  selectionAsync: vi.fn(),
  performAndroidHapticsAsync: vi.fn(),
  AndroidHaptics: {},
  ImpactFeedbackStyle: {},
  NotificationFeedbackType: {}
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))

const client = { sendRequest: vi.fn() } as unknown as RpcClient

function readySnapshot(branch: string): ReviewScreenState {
  return {
    kind: 'ready',
    status: { entries: [], branch, head: 'abc123' },
    comments: [],
    reviewState: { reviewedKeys: [] },
    branchCompare: null
  } as unknown as ReviewScreenState
}

describe('useMobileDiffReviewController', () => {
  let renderer: ReactTestRenderer | null = null
  let screenState: ReviewScreenState = { kind: 'loading' }

  function Probe({ connState }: { connState: ConnectionState }): null {
    const controller = useMobileDiffReviewController({
      client,
      connState,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      name: 'review',
      initialFilter: 'all',
      initialTarget: null,
      onOpenSession: () => {},
      onReconnect: () => {}
    })
    screenState = controller.screenState
    return null
  }

  async function update(connState: ConnectionState): Promise<void> {
    await act(async () => {
      renderer?.update(createElement(Probe, { connState }))
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    loadSnapshot.mockReset()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('keeps the loaded review across a disconnect and its reconnect reload', async () => {
    let releaseReload: (() => void) | null = null
    loadSnapshot.mockResolvedValueOnce(readySnapshot('feature/one')).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseReload = () => resolve(readySnapshot('feature/two'))
        })
    )

    await act(async () => {
      renderer = create(createElement(Probe, { connState: 'connected' }))
      await Promise.resolve()
    })
    expect(screenState).toMatchObject({ kind: 'ready' })

    await update('reconnecting')
    expect(screenState).toMatchObject({ kind: 'ready', status: { branch: 'feature/one' } })

    await update('connected')
    expect(screenState).toMatchObject({ kind: 'ready', status: { branch: 'feature/one' } })

    await act(async () => {
      releaseReload?.()
      await Promise.resolve()
    })
    expect(screenState).toMatchObject({ kind: 'ready', status: { branch: 'feature/two' } })
  })

  it('keeps the loaded review when the reconnect reload rejects', async () => {
    loadSnapshot
      .mockResolvedValueOnce(readySnapshot('feature/one'))
      .mockRejectedValueOnce(new Error('snapshot fetch failed'))

    await act(async () => {
      renderer = create(createElement(Probe, { connState: 'connected' }))
      await Promise.resolve()
    })
    expect(screenState).toMatchObject({ kind: 'ready' })

    await update('reconnecting')
    await update('connected')
    expect(loadSnapshot).toHaveBeenCalledTimes(2)
    // Why (F10): a failed refresh must not replace the review on screen with an error.
    expect(screenState).toMatchObject({ kind: 'ready', status: { branch: 'feature/one' } })
  })

  it('waits for the desktop when the drop lands before the review loads', async () => {
    loadSnapshot.mockReturnValueOnce(new Promise(() => {}))

    await act(async () => {
      renderer = create(createElement(Probe, { connState: 'connected' }))
      await Promise.resolve()
    })
    expect(screenState).toMatchObject({ kind: 'loading' })

    await update('disconnected')
    expect(screenState).toMatchObject({ kind: 'error', message: 'Waiting for desktop...' })
  })
})
