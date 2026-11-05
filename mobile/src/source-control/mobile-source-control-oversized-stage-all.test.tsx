import { createElement, useRef } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { createFakeBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
// Mock native Flow/haptics imports; retain the real bridge-to-error path.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
// Mock expo-router through the native routing seam to obtain a checked RouteHandoff.
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

import { BRIDGE_MAX_MESSAGE_BYTES } from '../mobile-web-shell/bridge/bridge-caps'
import { useRouteHandoff } from '../navigation/route-handoff'
import { useMobileGitRequests } from './use-mobile-git-requests'
import { useMobileSourceControlRunners } from './use-mobile-source-control-runners'

// Exercise the real oversized-frame refusal through the screen’s runner: the old shell silently dropped it and left busy state forever.
// Checking only the bridge or only a hand-thrown runner error would miss whether the screen actually displays this refusal.

const PATH_COUNT = 12_000
const STAGEABLE_PATHS = Array.from(
  { length: PATH_COUNT },
  (_, index) => `packages/app/src/features/some/deeply/nested/module/file-${index}-abcdefghij.ts`
)

function idleRunnerParams() {
  return {
    hostId: 'host-a',
    worktreeId: 'wt-1',
    status: null,
    branchLabel: 'main',
    commitMessage: '',
    stagedEntries: [],
    generatingMessage: false,
    unstageablePaths: [],
    sendCommitRequest: vi.fn(),
    runGitSyncSteps: vi.fn(),
    loadStatus: vi.fn().mockResolvedValue(true),
    setBusyAction: vi.fn(),
    setCommitMessage: vi.fn(),
    setGeneratingMessage: vi.fn(),
    setShowActionSheet: vi.fn(),
    setLocalBranches: vi.fn(),
    setShowBranchPicker: vi.fn(),
    setCreatedPrUrl: vi.fn(),
    setCreatedPrWarning: vi.fn(),
    recordCommitFailure: vi.fn()
  }
}

describe('stage-all over the outbound frame cap', () => {
  it('refuses the frame at the page rather than posting one the shell drops', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    const postedBefore = pair.toShell.length

    const rejection = await pair.client
      .sendRequest('git.bulkStage', { worktree: 'id:wt-1', filePaths: STAGEABLE_PATHS })
      .then(
        () => null,
        (error: unknown) => error
      )
    await pair.flush()

    expect(rejection).toBeInstanceOf(Error)
    expect(rejection instanceof Error ? rejection.name : String(rejection)).toBe(
      'BridgeRequestOversizedError'
    )
    // The frame never left, so this is definite failure and a smaller retry cannot duplicate host work.
    expect(pair.toShell.length).toBe(postedBefore)
    expect(pair.hostDiagnostics).toEqual([])
    expect(pair.diagnostics.map((entry) => entry.kind)).toEqual(['send-oversized'])
    const [diagnostic] = pair.diagnostics
    expect(diagnostic.kind === 'send-oversized' ? diagnostic.bytes : 0).toBeGreaterThan(
      BRIDGE_MAX_MESSAGE_BYTES
    )
  })

  it('reports the oversized action and suggests fewer files, then stops being busy', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    const setActionError = vi.fn()
    const setBusyAction = vi.fn()

    // Use a holder: TypeScript cannot prove Probe ran and would keep a local binding narrowed to null.
    const captured: { stageAll: (() => Promise<void>) | null } = { stageAll: null }
    function Probe(): null {
      const router = useRouteHandoff()
      const mountedRef = useRef(true)
      const busyActionRef = useRef<string | null>(null)
      const { sendGitRequest } = useMobileGitRequests({
        client: pair.client,
        connState: 'connected',
        worktreeId: 'wt-1'
      })
      captured.stageAll = useMobileSourceControlRunners({
        ...idleRunnerParams(),
        client: pair.client,
        router,
        stageablePaths: STAGEABLE_PATHS,
        sendGitRequest,
        mountedRef,
        busyActionRef,
        setBusyAction,
        setActionError
      }).stageAll
      return null
    }
    await act(async () => {
      create(createElement(Probe))
    })
    const run = captured.stageAll
    if (!run) {
      throw new Error('the runners hook never rendered')
    }
    await act(async () => {
      await run()
    })

    const message = setActionError.mock.calls.map(([value]) => value).findLast(Boolean)
    expect(message).toBeTruthy()
    expect(message).toMatch(/[a-z]{4}/)
    expect(message).not.toMatch(/^bridge_/)
    expect(message).toContain('fewer files')
    expect(setBusyAction.mock.calls.map(([value]) => value)).toEqual(['stage-all', null])
  })
})
