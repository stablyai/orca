import { describe, expect, it, vi } from 'vitest'
import { useMobileTasksProjectFileMergeActions } from './use-mobile-tasks-project-file-merge-actions'

vi.mock('./mobile-tasks-dependencies', () => ({ useCallback: (callback: unknown) => callback }))
vi.mock('./mobile-tasks-legacy-foundation', () => ({
  isSuccess: (response: { ok: boolean }) => response.ok,
  projectRowGitHubRepository: () => ({ owner: 'owner', repo: 'repo', host: 'github.com' })
}))

describe('Project mutation acceptance', () => {
  it('b2: null Project mutation result does not commit success', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ ok: true, result: null })
    const setProjectRowItem = vi.fn()
    const setGithubProjectTable = vi.fn()
    const setProjectRowDetailError = vi.fn()
    const setProjectMutating = vi.fn()
    const model = {
      client: { sendRequest },
      projectMutating: false,
      findProjectRowRepo: () => ({ id: 'repo-1' }),
      setProjectRowItem,
      setGithubProjectTable,
      setProjectRowDetailError,
      setProjectMutating
    } as unknown as Parameters<typeof useMobileTasksProjectFileMergeActions>[0]
    const actions = useMobileTasksProjectFileMergeActions(model)
    const row = {
      id: 'row-1',
      itemType: 'PULL_REQUEST',
      content: { number: 42, state: 'OPEN' }
    } as Parameters<typeof actions.mergeProjectGitHubPullRequest>[0]
    await actions.mergeProjectGitHubPullRequest(row, 'squash')
    expect(sendRequest).toHaveBeenCalledWith(
      'github.mergePR',
      {
        repo: 'id:repo-1',
        prNumber: 42,
        prRepo: { owner: 'owner', repo: 'repo', host: 'github.com' },
        method: 'squash'
      },
      { timeoutMs: 60_000 }
    )
    expect(setProjectRowItem).not.toHaveBeenCalled()
    expect(setGithubProjectTable).not.toHaveBeenCalled()
    expect(setProjectRowDetailError.mock.calls.at(-1)?.[0]).toMatch(/null/)
    expect(setProjectMutating).toHaveBeenLastCalledWith(false)
  })
})
