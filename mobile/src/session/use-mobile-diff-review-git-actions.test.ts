import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import { useMobileDiffReviewGitActions } from './use-mobile-diff-review-git-actions'

const haptics = vi.hoisted(() => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))
vi.mock('../platform/haptics', () => haptics)

type GitActions = ReturnType<typeof useMobileDiffReviewGitActions>
type MountedHarness = {
  unmount: () => void
  update: (element: ReturnType<typeof createElement>) => void
}

function success(): RpcResponse {
  return { id: 'rpc', ok: true, result: { ok: true }, _meta: { runtimeId: 'runtime' } }
}

function failure(code: string, message: string): RpcResponse {
  return { id: 'rpc', ok: false, error: { code, message }, _meta: { runtimeId: 'runtime' } }
}

function reviewedFile(filePath: string): MobileDiffReviewQueueItem {
  return {
    key: `unstaged\0unstaged\0\0${filePath}`,
    scope: 'unstaged',
    area: 'unstaged',
    filePath,
    status: 'modified',
    title: filePath,
    subtitle: 'Unstaged',
    canStage: true,
    canUnstage: false,
    canDiscard: true,
    isGeneratedOrLockFile: false,
    diffIdentity: `diff-${filePath}`,
    noteCount: 0,
    unsentNoteCount: 0,
    staleNoteCount: 0,
    reviewedAt: 1,
    isReviewed: true,
    changedSinceReview: false
  }
}

function createGenerationClient(sendRequest: ReturnType<typeof vi.fn>) {
  const logicalGeneration = 1
  let lastConnectedAt = 100
  const client = {
    sendRequest,
    getGeneration: () => logicalGeneration,
    getLastConnectedAt: () => lastConnectedAt
  } as unknown as RpcClient
  return {
    client,
    advanceConnection: () => {
      lastConnectedAt += 1
    }
  }
}

describe('useMobileDiffReviewGitActions', () => {
  let renderer: MountedHarness | null = null
  let actions: GitActions | null = null
  let client: RpcClient
  let queue: MobileDiffReviewQueueItem[]
  let setActionError: ReturnType<typeof vi.fn>
  let setBusyAction: ReturnType<typeof vi.fn>
  let loadReviewData: ReturnType<typeof vi.fn>

  function Harness(): null {
    actions = useMobileDiffReviewGitActions({
      client,
      connState: 'connected',
      worktreeId: 'wt-1',
      queue,
      setActionError,
      setBusyAction,
      loadReviewData
    })
    return null
  }

  async function mount(): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness))
    })
  }

  async function rerender(): Promise<void> {
    await act(async () => {
      renderer?.update(createElement(Harness))
    })
  }

  async function stageReviewedFiles(): Promise<void> {
    await act(async () => {
      await actions?.stageReviewedFiles()
    })
  }

  beforeEach(() => {
    queue = []
    setActionError = vi.fn()
    setBusyAction = vi.fn()
    loadReviewData = vi.fn().mockResolvedValue(undefined)
    haptics.triggerError.mockReset()
    haptics.triggerSuccess.mockReset()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    actions = null
  })

  it('stages 100 reviewed files with one bulk RPC', async () => {
    const paths = Array.from({ length: 100 }, (_, index) => `src/reviewed-${index}.ts`)
    queue = [
      ...paths.map(reviewedFile),
      { ...reviewedFile('src/unreviewed.ts'), isReviewed: false },
      { ...reviewedFile('src/already-staged.ts'), scope: 'staged', area: 'staged' },
      { ...reviewedFile('src/conflicted.ts'), canStage: false }
    ]
    const sendRequest = vi.fn().mockResolvedValue(success())
    client = createGenerationClient(sendRequest).client
    await mount()

    await stageReviewedFiles()

    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenCalledWith('git.bulkStage', {
      worktree: 'id:wt-1',
      filePaths: paths
    })
    expect(setBusyAction.mock.calls).toEqual([['stage-reviewed'], [null]])
    expect(setActionError).toHaveBeenLastCalledWith('100 reviewed files staged')
    expect(haptics.triggerSuccess).toHaveBeenCalledTimes(1)
    expect(haptics.triggerError).not.toHaveBeenCalled()
    expect(loadReviewData).toHaveBeenCalledTimes(1)
  })

  it('ignores repeated staging while the bulk mutation is in flight', async () => {
    queue = [reviewedFile('src/a.ts')]
    let resolveBulk!: (response: RpcResponse) => void
    const sendRequest = vi.fn(
      () =>
        new Promise<RpcResponse>((resolve) => {
          resolveBulk = resolve
        })
    )
    client = createGenerationClient(sendRequest).client
    await mount()

    let first: Promise<void> | undefined
    let second: Promise<void> | undefined
    await act(async () => {
      first = actions?.stageReviewedFiles()
      second = actions?.stageReviewedFiles()
      await Promise.resolve()
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)

    resolveBulk(success())
    await act(async () => {
      await Promise.all([first, second])
    })
    expect(haptics.triggerSuccess).toHaveBeenCalledTimes(1)
    expect(loadReviewData).toHaveBeenCalledTimes(1)
    expect(setBusyAction.mock.calls).toEqual([['stage-reviewed'], [null]])
  })

  it('falls back only after exact method_not_found and preserves the partial summary', async () => {
    queue = [reviewedFile('src/a.ts'), reviewedFile('src/b.ts')]
    const sendRequest = vi.fn(async (method: string, params: { filePath?: string }) => {
      if (method === 'git.bulkStage') {
        return failure('method_not_found', 'legacy desktop')
      }
      return params.filePath === 'src/a.ts' ? success() : failure('git_failed', 'blocked')
    })
    client = createGenerationClient(sendRequest).client
    await mount()

    await stageReviewedFiles()

    expect(sendRequest.mock.calls).toEqual([
      ['git.bulkStage', { worktree: 'id:wt-1', filePaths: ['src/a.ts', 'src/b.ts'] }],
      ['git.stage', { worktree: 'id:wt-1', filePath: 'src/a.ts' }],
      ['git.stage', { worktree: 'id:wt-1', filePath: 'src/b.ts' }]
    ])
    expect(setActionError).toHaveBeenLastCalledWith('1 staged, 1 failed')
    expect(haptics.triggerSuccess).toHaveBeenCalledTimes(1)
    expect(haptics.triggerError).not.toHaveBeenCalled()
    expect(loadReviewData).toHaveBeenCalledTimes(1)
  })

  it('caches an old host only for the current connection generation', async () => {
    queue = [reviewedFile('src/a.ts')]
    let bulkSupported = false
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'git.bulkStage' && !bulkSupported) {
        return failure('method_not_found', 'legacy desktop')
      }
      return success()
    })
    const generationClient = createGenerationClient(sendRequest)
    client = generationClient.client
    await mount()

    await stageReviewedFiles()
    sendRequest.mockClear()
    await stageReviewedFiles()
    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual(['git.stage'])

    bulkSupported = true
    generationClient.advanceConnection()
    sendRequest.mockClear()
    await stageReviewedFiles()
    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual(['git.bulkStage'])
  })

  it('does not cache a stale method_not_found response for a new generation', async () => {
    queue = [reviewedFile('src/a.ts')]
    let resolveBulk!: (response: RpcResponse) => void
    let firstBulk = true
    const sendRequest = vi.fn((method: string) => {
      if (method === 'git.bulkStage' && firstBulk) {
        firstBulk = false
        return new Promise<RpcResponse>((resolve) => {
          resolveBulk = resolve
        })
      }
      return Promise.resolve(success())
    })
    const generationClient = createGenerationClient(sendRequest)
    client = generationClient.client
    await mount()

    let pending: Promise<void> | undefined
    await act(async () => {
      pending = actions?.stageReviewedFiles()
      await Promise.resolve()
    })
    generationClient.advanceConnection()
    resolveBulk(failure('method_not_found', 'legacy desktop'))
    await act(async () => {
      await pending
    })

    sendRequest.mockClear()
    await stageReviewedFiles()
    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual(['git.bulkStage'])
  })

  it('does not let an old client capability result poison its replacement', async () => {
    queue = [reviewedFile('src/a.ts')]
    const oldSendRequest = vi.fn(async (method: string) =>
      method === 'git.bulkStage' ? failure('method_not_found', 'legacy desktop') : success()
    )
    client = createGenerationClient(oldSendRequest).client
    await mount()
    await stageReviewedFiles()

    const replacementSendRequest = vi.fn().mockResolvedValue(success())
    client = createGenerationClient(replacementSendRequest).client
    await rerender()
    await stageReviewedFiles()

    expect(replacementSendRequest).toHaveBeenCalledTimes(1)
    expect(replacementSendRequest).toHaveBeenCalledWith('git.bulkStage', {
      worktree: 'id:wt-1',
      filePaths: ['src/a.ts']
    })
  })

  it.each(['forbidden', 'runtime_error'])(
    'refreshes after a %s bulk failure without per-file fanout',
    async (code) => {
      queue = [reviewedFile('src/a.ts'), reviewedFile('src/b.ts')]
      const sendRequest = vi.fn().mockResolvedValue(failure(code, 'Unknown method: git.bulkStage'))
      client = createGenerationClient(sendRequest).client
      await mount()

      await stageReviewedFiles()

      expect(sendRequest).toHaveBeenCalledTimes(1)
      expect(sendRequest).toHaveBeenCalledWith('git.bulkStage', {
        worktree: 'id:wt-1',
        filePaths: ['src/a.ts', 'src/b.ts']
      })
      expect(setActionError).toHaveBeenLastCalledWith('Unknown method: git.bulkStage')
      expect(setBusyAction).toHaveBeenLastCalledWith(null)
      expect(haptics.triggerError).toHaveBeenCalledTimes(1)
      expect(haptics.triggerSuccess).not.toHaveBeenCalled()
      expect(loadReviewData).toHaveBeenCalledTimes(1)
    }
  )

  it('refreshes after a rejected bulk request without retrying individual files', async () => {
    queue = [reviewedFile('src/a.ts'), reviewedFile('src/b.ts')]
    const sendRequest = vi.fn().mockRejectedValue(new Error('delivery unknown'))
    client = createGenerationClient(sendRequest).client
    await mount()

    await stageReviewedFiles()

    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(setActionError).toHaveBeenLastCalledWith('delivery unknown')
    expect(setBusyAction).toHaveBeenLastCalledWith(null)
    expect(haptics.triggerError).toHaveBeenCalledTimes(1)
    expect(loadReviewData).toHaveBeenCalledTimes(1)
  })
})
