import { expect, it, vi } from 'vitest'
import type * as GitHubApiRepository from '../../../github/github-api-repository'
import { RuntimeGitHubIssueCommentCommands } from './runtime-github-issue-comment-commands'
const { resolve, upload } = vi.hoisted(() => ({ resolve: vi.fn(), upload: vi.fn() }))
vi.mock('../../../github/image-attachment-upload', () => ({ uploadGitHubImage: upload }))
vi.mock('../../../github/github-api-repository', async (original) => ({
  ...(await original<typeof GitHubApiRepository>()),
  resolveGitHubRepoExecution: resolve
}))
it('resolves the addressed worktree with the existing SSH/WSL gh execution options at upload time', async () => {
  const repo = {
    id: 'repo',
    path: '/root',
    connectionId: 'ssh-1',
    executionHostId: 'ssh:ssh-1',
    displayName: '',
    badgeColor: '',
    addedAt: 1
  }
  const resolveTarget = vi.fn().mockResolvedValue({ repo, repoPath: '/linked/worktree' })
  resolve.mockResolvedValue({
    ownerRepo: { owner: 'octo', repo: 'images' },
    ghOptions: { connectionId: 'ssh-1' }
  })
  upload.mockImplementation(async (args) => {
    await args.resolve(new AbortController().signal)
    return { url: 'https://github.com/user-attachments/assets/a' }
  })
  const runtime = new RuntimeGitHubIssueCommentCommands({
    resolveRepo: vi.fn(),
    resolveTarget,
    getLocalGitArgs: () => [{ wslDistro: 'Ubuntu' }]
  })
  await runtime.uploadGitHubAttachment(
    {
      target: { kind: 'repo', repo: 'repo', worktree: 'path:/linked/worktree', source: 'origin' },
      fileName: 'a.png',
      contentType: 'image/png'
    },
    Buffer.from([1])
  )
  expect(resolveTarget).toHaveBeenCalledExactlyOnceWith({
    repoSelector: 'repo',
    worktreeSelector: 'path:/linked/worktree'
  })
  expect(resolve).toHaveBeenCalledWith(
    '/linked/worktree',
    undefined,
    'ssh-1',
    expect.objectContaining({ wslDistro: 'Ubuntu' })
  )
})
