import { createElement, useRef } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { createFakeBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
// Why these and only these: react-native is Flow source vitest will not parse, and the haptics seam
// reaches expo-haptics through it. Everything between the bridge and the error surface — the client,
// `sendGitRequest`, `runGitWorkflow` — is the real module.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
// The seam's native file is the router and nothing else, so mocking expo-router under it is how
// this gets a `RouteHandoff` without asserting one into existence. No target is pressed here.
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

/**
 * Stage-all over the outbound frame cap, from the bridge to the text on the panel.
 *
 * Requests are never chunked, so a page→shell frame is one frame: `git.bulkStage` carries every
 * changed path, and past roughly nine thousand of them at this repository's mean path length the
 * frame is over `BRIDGE_MAX_MESSAGE_BYTES`. The design accepted that bound rather than adding a
 * path-free `git.stageAll` an older desktop would not answer (rulings-ota-c4.md ruling 2), on the
 * condition that the page shows the refusal as something the user can read.
 *
 * It did not. The shell's reader drops an oversized frame with a diagnostic and answers nothing, so
 * the page's promise stayed pending for the life of the document: `busyAction` never cleared, the
 * spinner never stopped, and `setActionError` was never called. Measured on this tree before the
 * refusal moved to the sending side — one frame posted at 1,033,012 bytes, host diagnostic
 * `{ kind: 'refused', refusal: 'oversized' }`, caller still pending after a full flush.
 *
 * Both halves are here rather than in two files because neither half alone is the claim. The bridge
 * rejecting proves nothing about what the screen does with the rejection, and a runner test with a
 * hand-thrown error proves nothing about what the bridge actually raises.
 */

/** Long enough that stage-all's one frame cannot fit, in the shape `git.status` reports paths. */
const PATH_COUNT = 12_000
const STAGEABLE_PATHS = Array.from(
  { length: PATH_COUNT },
  (_, index) => `packages/app/src/features/some/deeply/nested/module/file-${index}-abcdefghij.ts`
)

/** Everything the runners hook needs that this case does not exercise. */
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
    // Named rather than matched on the text, so the message stays free to be reworded.
    expect(rejection instanceof Error ? rejection.name : String(rejection)).toBe(
      'BridgeRequestOversizedError'
    )
    // The frame never left, which is what makes this a definite failure: nothing ran on the
    // desktop, so the caller may say so and may offer the smaller retry.
    expect(pair.toShell.length).toBe(postedBefore)
    expect(pair.hostDiagnostics).toEqual([])
    expect(pair.diagnostics.map((entry) => entry.kind)).toEqual(['send-oversized'])
    const [diagnostic] = pair.diagnostics
    expect(diagnostic.kind === 'send-oversized' ? diagnostic.bytes : 0).toBeGreaterThan(
      BRIDGE_MAX_MESSAGE_BYTES
    )
  })

  it('puts a readable message on the panel’s error surface, and stops being busy', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    const setActionError = vi.fn()
    const setBusyAction = vi.fn()

    // A holder rather than a `let`: the assignment happens inside `Probe`, which TypeScript
    // cannot prove ran, so a plain binding stays narrowed to `null` past the guard below.
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

    // The whole point of the ruling: what lands here is a sentence, not a code, not null, and not
    // the empty string a silent path would have left.
    const message = setActionError.mock.calls.map(([value]) => value).findLast(Boolean)
    expect(message).toBeTruthy()
    expect(message).toMatch(/[a-z]{4}/)
    expect(message).not.toMatch(/^bridge_/)
    // And the screen is not left spinning: the busy flag is raised and then cleared.
    expect(setBusyAction.mock.calls.map(([value]) => value)).toEqual(['stage-all', null])
  })
})
