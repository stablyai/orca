import { createElement, useRef } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi, type Mock } from 'vitest'
// Mock haptics because react-native is Flow source Vitest cannot parse.
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
import { GIT_STAGE_WORKTREE_SCOPE_UNSUPPORTED_MESSAGE } from '../../../src/shared/git-stage-worktree-scope'
import { gitStatusHostPayloadSchema } from './git-status-reply-schema'
import type { MobileGitStatusResult } from './mobile-git-status'
import { useMobileSourceControlRunners } from './use-mobile-source-control-runners'

const LISTED = ['src/a.ts', 'src/b.ts']

function cappedStatus(): MobileGitStatusResult {
  return gitStatusHostPayloadSchema.parse({
    entries: LISTED.map((path) => ({ path, status: 'modified', area: 'unstaged' })),
    didHitLimit: true
  })
}

type SendGitRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>
type SendGitCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

function asSendGitRequest(recorder: Mock<SendGitCall>): SendGitRequest {
  return async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
    const reply = await recorder(method, params)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each test resolves the recorder with the git.bulkStage reply shape the stage-all runner reads.
    return reply as T
  }
}

async function runStageAll(
  status: MobileGitStatusResult,
  recorder: Mock<SendGitCall>
): Promise<{ setActionError: ReturnType<typeof vi.fn> }> {
  const sendGitRequest = asSendGitRequest(recorder)
  const setActionError = vi.fn()
  const captured: { stageAll: (() => Promise<void>) | null } = { stageAll: null }
  function Probe(): null {
    const router = useRouteHandoff()
    const mountedRef = useRef(true)
    const busyActionRef = useRef<string | null>(null)
    captured.stageAll = useMobileSourceControlRunners({
      client: null,
      hostId: 'host-a',
      worktreeId: 'wt-1',
      status,
      branchLabel: 'main',
      commitMessage: '',
      stagedEntries: [],
      generatingMessage: false,
      stageablePaths: LISTED,
      unstageablePaths: [],
      router,
      sendGitRequest,
      sendCommitRequest: vi.fn(),
      runGitSyncSteps: vi.fn(),
      loadStatus: vi.fn().mockResolvedValue(true),
      mountedRef,
      busyActionRef,
      setBusyAction: vi.fn(),
      setActionError,
      setCommitMessage: vi.fn(),
      setGeneratingMessage: vi.fn(),
      setShowActionSheet: vi.fn(),
      setLocalBranches: vi.fn(),
      setShowBranchPicker: vi.fn(),
      setCreatedPrUrl: vi.fn(),
      setCreatedPrWarning: vi.fn(),
      recordCommitFailure: vi.fn()
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
  return { setActionError }
}

describe('mobile Stage All on a capped git.status', () => {
  it('asks the host to stage every change instead of the capped rows', async () => {
    const sendGitRequest = vi.fn<SendGitCall>().mockResolvedValue({ ok: true, stagedScope: 'all' })

    const { setActionError } = await runStageAll(cappedStatus(), sendGitRequest)

    expect(sendGitRequest).toHaveBeenCalledWith('git.bulkStage', { filePaths: [], scope: 'all' })
    expect(setActionError.mock.calls.map(([value]) => value).filter(Boolean)).toEqual([])
  })

  it('reports an older host that answered without a receipt', async () => {
    // Older hosts strip scope and may accept an empty list without staging anything.
    const sendGitRequest = vi.fn<SendGitCall>().mockResolvedValue({ ok: true })

    const { setActionError } = await runStageAll(cappedStatus(), sendGitRequest)

    expect(setActionError).toHaveBeenLastCalledWith(GIT_STAGE_WORKTREE_SCOPE_UNSUPPORTED_MESSAGE)
  })

  it('still stages the listed rows when the listing is complete', async () => {
    const sendGitRequest = vi.fn<SendGitCall>().mockResolvedValue({ ok: true })
    const complete = gitStatusHostPayloadSchema.parse({
      entries: LISTED.map((path) => ({ path, status: 'modified', area: 'unstaged' }))
    })

    await runStageAll(complete, sendGitRequest)

    expect(sendGitRequest).toHaveBeenCalledWith('git.bulkStage', { filePaths: LISTED })
  })
})
