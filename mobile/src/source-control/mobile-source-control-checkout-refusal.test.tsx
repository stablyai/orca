import { createElement, useRef } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
// Mock native Flow/haptics imports, as the other runner tests do.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('expo-router', () => ({
  useRouter: () => ({
    back: () => undefined,
    push: () => undefined,
    replace: () => undefined,
    navigate: () => undefined,
    dismissTo: () => undefined,
    prefetch: () => undefined,
    canGoBack: () => false,
    setParams: () => undefined
  })
}))
vi.mock('../platform/haptics', () => ({
  triggerSuccess: () => undefined,
  triggerError: () => undefined,
  triggerSelection: () => undefined,
  triggerWarning: () => undefined,
  triggerImpact: () => undefined
}))

import { useRouteHandoff } from '../navigation/route-handoff'
import { useMobileSourceControlRunners } from './use-mobile-source-control-runners'

const REFUSAL = 'Commit or discard 2 changed files before switching branches.'

describe('phone Switch branch outcome', () => {
  it('keeps the host reason visible while it reloads the branch the checkout is on', async () => {
    const setActionError = vi.fn()
    const loadStatus = vi.fn().mockResolvedValue(true)
    const captured: { checkout: ((branch: string) => Promise<void>) | null } = { checkout: null }
    function Probe(): null {
      const router = useRouteHandoff()
      const mountedRef = useRef(true)
      const busyActionRef = useRef<string | null>(null)
      captured.checkout = useMobileSourceControlRunners({
        client: null,
        hostId: 'host-a',
        worktreeId: 'wt-1',
        status: null,
        commitMessage: '',
        stagedEntries: [],
        generatingMessage: false,
        stageablePaths: [],
        unstageablePaths: [],
        router,
        sendGitRequest: async () => {
          throw new Error(REFUSAL)
        },
        sendCommitRequest: vi.fn(),
        runGitSyncSteps: vi.fn(),
        loadStatus,
        mountedRef,
        busyActionRef,
        setBusyAction: vi.fn(),
        setActionError,
        setCommitMessage: vi.fn(),
        setGeneratingMessage: vi.fn(),
        setShowActionSheet: vi.fn(),
        setLocalBranches: vi.fn(),
        setShowBranchPicker: vi.fn(),
        recordCommitFailure: vi.fn()
      }).checkoutBranch
      return null
    }
    await act(async () => {
      create(createElement(Probe))
    })
    const checkout = captured.checkout
    if (!checkout) {
      throw new Error('the runners hook never rendered')
    }
    await act(async () => {
      await checkout('feature')
    })

    expect(setActionError).toHaveBeenLastCalledWith(REFUSAL)
    expect(loadStatus).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, clearActionErrorOnSuccess: false })
    )
  })
})
