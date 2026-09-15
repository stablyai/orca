import { describe, expect, it, vi } from 'vitest'
import { useMobileTasksProjectFileMergeActions } from './use-mobile-tasks-project-file-merge-actions'

vi.mock('./mobile-tasks-dependencies', () => ({ useCallback: (callback: unknown) => callback }))
vi.mock('./mobile-tasks-legacy-foundation', () => ({
  isSuccess: (response: { ok: boolean }) => response.ok,
  projectRowGitHubRepository: () => ({ owner: 'owner', repo: 'repo', host: 'github.com' })
}))

const OPEN_PR_ROW = {
  id: 'row-1',
  itemType: 'PULL_REQUEST',
  content: { number: 42, state: 'OPEN' }
} as Parameters<
  ReturnType<typeof useMobileTasksProjectFileMergeActions>['mergeProjectGitHubPullRequest']
>[0]

function projectMergeProbe(result: unknown) {
  const spies = {
    sendRequest: vi.fn().mockResolvedValue({ ok: true, result }),
    setProjectRowItem: vi.fn(),
    setGithubProjectTable: vi.fn(),
    setProjectRowDetailError: vi.fn(),
    setProjectMutating: vi.fn()
  }
  const model = {
    client: { sendRequest: spies.sendRequest },
    projectMutating: false,
    findProjectRowRepo: () => ({ id: 'repo-1' }),
    ...spies
  } as unknown as Parameters<typeof useMobileTasksProjectFileMergeActions>[0]
  return { model, spies }
}

/** The oracle is the outcome, never the message: the pinned reference at bcba08b3e4 accepts a
 *  missing result through `response.result?.ok === false` and commits the row, so committing is
 *  what has to stay impossible. Any rejection shape passes — today's throw and a later explicit
 *  guard both surface a non-empty error and leave the row untouched. */
function expectRejected(spies: ReturnType<typeof projectMergeProbe>['spies']): void {
  expect(spies.sendRequest).toHaveBeenCalledWith(
    'github.mergePR',
    {
      repo: 'id:repo-1',
      prNumber: 42,
      prRepo: { owner: 'owner', repo: 'repo', host: 'github.com' },
      method: 'squash'
    },
    { timeoutMs: 60_000 }
  )
  expect(spies.setProjectRowItem).not.toHaveBeenCalled()
  expect(spies.setGithubProjectTable).not.toHaveBeenCalled()
  expect(spies.setProjectRowDetailError).toHaveBeenLastCalledWith(expect.stringMatching(/\S/))
  expect(spies.setProjectMutating).toHaveBeenLastCalledWith(false)
}

describe('Project mutation acceptance', () => {
  it('b2: null Project mutation result does not commit success', async () => {
    const { model, spies } = projectMergeProbe(null)
    await useMobileTasksProjectFileMergeActions(model).mergeProjectGitHubPullRequest(
      OPEN_PR_ROW,
      'squash'
    )
    expectRejected(spies)
  })

  it('b2: undefined Project mutation result does not commit success', async () => {
    const { model, spies } = projectMergeProbe(undefined)
    await useMobileTasksProjectFileMergeActions(model).mergeProjectGitHubPullRequest(
      OPEN_PR_ROW,
      'squash'
    )
    expectRejected(spies)
  })
})
