import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayContext } from './context'
import { GitHandler } from './git-handler'
import {
  createMockDispatcher,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'

type GitHandlerSpies = {
  git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>
  gitBuffer(args: string[], cwd: string): Promise<Buffer>
  spawnClone(
    args: string[],
    cwd: string,
    progressId: string
  ): Promise<{ stdout: string; stderr: string }>
}

describe('GitHandler submodule cache invalidation', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler
  let target: GitHandlerSpies

  beforeEach(() => {
    dispatcher = createMockDispatcher()
    handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
    target = handler as unknown as GitHandlerSpies
    vi.spyOn(target, 'git').mockResolvedValue({ stdout: '', stderr: '' })
    vi.spyOn(target, 'gitBuffer').mockResolvedValue(Buffer.from('content\n'))
  })

  afterEach(() => {
    handler.dispose()
  })

  it.each([
    {
      name: 'clone',
      mutate: async () => {
        vi.spyOn(target, 'spawnClone').mockResolvedValue({ stdout: '', stderr: '' })
        await dispatcher.callRequest('git.clone', {
          args: ['clone', '--', 'https://example.com/repo.git', 'repo'],
          cwd: '/projects',
          progressId: 'clone-test'
        })
      }
    },
    {
      name: 'mutating git.exec',
      mutate: () =>
        dispatcher.callRequest('git.exec', {
          args: ['commit', '--allow-empty', '-m', 'initialize'],
          cwd: '/repo'
        })
    }
  ])('clears a cached empty .gitmodules result around $name', async ({ mutate }) => {
    const diffRequest = {
      worktreePath: '/repo',
      filePath: 'src/file.ts',
      staged: false
    }

    await dispatcher.callRequest('git.diff', diffRequest)
    await mutate()
    await dispatcher.callRequest('git.diff', diffRequest)

    const gitSpy = vi.mocked(target.git)
    const submodulePathReads = gitSpy.mock.calls.filter(
      ([args]) => args[0] === 'config' && args.includes('.gitmodules')
    )
    expect(submodulePathReads).toHaveLength(2)
  })
})
