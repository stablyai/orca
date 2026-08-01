import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClientError } from '../runtime-client'

const callMock = vi.hoisted(() => vi.fn())

vi.mock('../format', () => ({
  formatWorktreeList: vi.fn(),
  formatWorktreePs: vi.fn(),
  formatWorktreeShow: vi.fn(),
  printResult: vi.fn()
}))
vi.mock('../selectors', () => ({
  getOptionalWorktreeSelector: vi.fn(),
  getRequiredWorktreeSelector: vi.fn(),
  resolveCurrentWorktreeSelector: vi.fn()
}))
vi.mock('../worktree-project-target', () => ({
  assertWorkspaceTargetFlagsCompatible: vi.fn(),
  hasWorkspaceProjectTarget: vi.fn(() => false),
  resolveProjectCreateRepoSelector: vi.fn(async () => undefined)
}))
vi.mock('./worktree-create-parent-selector', () => ({
  assertCreateParentFlagsCompatible: vi.fn(),
  resolveCreateParentSelector: vi.fn(async () => ({
    parentWorktree: undefined,
    parentWorkspace: undefined
  }))
}))
vi.mock('./worktree-linear-issue-link', () => ({
  getOptionalLinearIssueLinkFlag: vi.fn(() => ({}))
}))
vi.mock('./worktree-lineage-summary', () => ({ printLineageSummary: vi.fn() }))

import { WORKTREE_HANDLERS } from './worktree'

describe('worktree create mutation identity', () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ result: {} })
  })

  const invoke = (flags: Map<string, string | boolean>) =>
    WORKTREE_HANDLERS['worktree create']({
      flags,
      client: { call: callMock },
      cwd: 'D:\\Repos\\repo',
      json: true
    } as never)

  it('sends a fresh client mutation id for each create invocation', async () => {
    await invoke(
      new Map<string, string | boolean>([
        ['repo', 'id:repo'],
        ['name', 'slow-create'],
        ['no-parent', true]
      ])
    )

    expect(callMock).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ clientMutationId: expect.any(String) })
    )
  })

  it('passes an explicit mutation id through unchanged', async () => {
    await invoke(
      new Map<string, string | boolean>([
        ['repo', 'id:repo'],
        ['name', 'slow-create'],
        ['no-parent', true],
        ['mutation-id', 'retry-7410']
      ])
    )

    expect(callMock).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ clientMutationId: 'retry-7410' })
    )
  })

  it('includes the sent id in response-loss retry guidance', async () => {
    callMock.mockRejectedValue(
      new RuntimeClientError('runtime_unavailable', 'The runtime closed before responding.', {
        requestPhase: 'awaiting_response',
        mutationMayHaveCompleted: true
      })
    )

    await expect(
      invoke(
        new Map<string, string | boolean>([
          ['repo', 'id:repo'],
          ['name', 'slow-create'],
          ['no-parent', true],
          ['mutation-id', 'retry-7410']
        ])
      )
    ).rejects.toMatchObject({
      data: {
        nextSteps: expect.arrayContaining([expect.stringContaining('--mutation-id retry-7410')])
      }
    })
  })

  it('uses the generated id in response-loss retry guidance', async () => {
    callMock.mockRejectedValue(
      new RuntimeClientError('runtime_unavailable', 'The runtime closed before responding.', {
        requestPhase: 'awaiting_response',
        mutationMayHaveCompleted: true
      })
    )

    let thrown: unknown
    try {
      await invoke(
        new Map<string, string | boolean>([
          ['repo', 'id:repo'],
          ['name', 'slow-create'],
          ['no-parent', true]
        ])
      )
    } catch (error) {
      thrown = error
    }

    const sentId = (callMock.mock.calls[0]?.[1] as { clientMutationId?: string })?.clientMutationId
    expect(sentId).toEqual(expect.any(String))
    expect(thrown).toMatchObject({
      data: {
        nextSteps: expect.arrayContaining([expect.stringContaining(`--mutation-id ${sentId}`)])
      }
    })
  })

  it('rejects mutation ids longer than the runtime schema limit', async () => {
    await expect(
      invoke(
        new Map<string, string | boolean>([
          ['repo', 'id:repo'],
          ['name', 'slow-create'],
          ['no-parent', true],
          ['mutation-id', 'x'.repeat(129)]
        ])
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })
})
