import { createElement, useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { MobileGenerateCommitMessageResult } from './mobile-commit-message-ai'

// Why: react-native is Flow source vitest will not parse; haptics reaches expo-haptics through it.
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
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))
const ai = vi.hoisted(() => {
  const held: {
    resolve: ((result: MobileGenerateCommitMessageResult) => void) | null
    cancel: Mock<() => void>
  } = { resolve: null, cancel: vi.fn<() => void>() }
  return held
})
vi.mock('./mobile-commit-message-ai', () => ({
  requestMobileCommitMessage: () =>
    new Promise<MobileGenerateCommitMessageResult>((resolve) => {
      ai.resolve = resolve
    }),
  cancelMobileCommitMessage: async () => ai.cancel()
}))

import { useRouteHandoff } from '../navigation/route-handoff'
import { useMobileSourceControlRunners } from './use-mobile-source-control-runners'
import { stubRpcClient } from '../transport/rpc-client-test-stub'

const client = stubRpcClient()
type Runners = ReturnType<typeof useMobileSourceControlRunners>
const view: {
  message: string
  type: ((next: string) => void) | null
  runners: Runners | null
} = { message: '', type: null, runners: null }

function Harness(): null {
  const router = useRouteHandoff()
  const [commitMessage, setCommitMessage] = useState('')
  const [generatingMessage, setGeneratingMessage] = useState(false)
  const mountedRef = useRef(true)
  const busyActionRef = useRef<string | null>(null)
  view.message = commitMessage
  view.type = setCommitMessage
  view.runners = useMobileSourceControlRunners({
    client,
    hostId: 'host-a',
    worktreeId: 'wt-1',
    status: null,
    branchLabel: 'main',
    commitMessage,
    stagedEntries: [],
    generatingMessage,
    stageablePaths: [],
    unstageablePaths: [],
    router,
    sendGitRequest: vi.fn(),
    sendCommitRequest: vi.fn().mockResolvedValue({ success: true }),
    runGitSyncSteps: vi.fn(),
    loadStatus: vi.fn().mockResolvedValue(true),
    mountedRef,
    busyActionRef,
    setBusyAction: vi.fn(),
    setActionError: vi.fn(),
    setCommitMessage,
    setGeneratingMessage,
    setShowActionSheet: vi.fn(),
    setLocalBranches: vi.fn(),
    setShowBranchPicker: vi.fn(),
    setCreatedPrUrl: vi.fn(),
    setCreatedPrWarning: vi.fn(),
    recordCommitFailure: vi.fn()
  })
  return null
}

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  ai.resolve = null
  ai.cancel.mockClear()
})

describe('committing while the AI is still writing a message', () => {
  it('cancels the generation so its late reply does not refill the emptied box', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    let generating: Promise<void> | undefined
    act(() => {
      generating = view.runners?.generateCommitMessage()
    })
    act(() => view.type?.('fix: my own words'))
    await act(async () => {
      await view.runners?.commit()
    })
    expect(ai.cancel).toHaveBeenCalledTimes(1)
    expect(view.message).toBe('')

    await act(async () => {
      ai.resolve?.({ success: true, message: 'feat: generated for the old diff' })
      await generating
    })
    expect(view.message).toBe('')
  })
})
