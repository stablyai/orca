import { describe, expect, it, vi } from 'vitest'
import { getPullRequestDraftContext } from './pull-request-context'

type GitExec = Parameters<typeof getPullRequestDraftContext>[0]

function createContextInput(base = 'main') {
  return {
    base,
    currentTitle: 'Existing title',
    currentBody: 'Existing body',
    currentDraft: false
  }
}

describe('getPullRequestDraftContext', () => {
  it('fetches and rebases onto the resolved remote base before collecting PR context', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: 'origin/HEAD\norigin/main\nupstream/main\n', stderr: '' }
      }
      if (args[0] === 'rebase') {
        return { stdout: 'Current branch feature is up to date.\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'unchanged-head\n', stderr: '' }
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature/pr-details\n', stderr: '' }
      }
      if (args[0] === 'merge-base') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'log') {
        return { stdout: '- feat: summarize branch\n', stderr: '' }
      }
      if (args[0] === 'diff' && args[1] === '--name-status') {
        return { stdout: 'M\tsrc/file.ts\n', stderr: '' }
      }
      if (args[0] === 'diff') {
        return { stdout: 'diff --git a/src/file.ts b/src/file.ts\n+change\n', stderr: '' }
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    const context = await getPullRequestDraftContext(execGit, createContextInput())

    expect(context).toMatchObject({
      branch: 'feature/pr-details',
      base: 'main',
      branchChangedByPreparation: false,
      commitSummary: '- feat: summarize branch',
      changeSummary: 'M\tsrc/file.ts'
    })
    expect(execGit).toHaveBeenCalledWith(['fetch', '--all', '--prune'], expect.any(Object))
    expect(execGit).toHaveBeenCalledWith(['rebase', 'origin/main'], expect.any(Object))
    expect(execGit).toHaveBeenCalledWith(['merge-base', 'origin/main', 'HEAD'], expect.any(Object))

    const commandNames = execGit.mock.calls.map(([args]) => args[0])
    expect(commandNames.indexOf('rebase')).toBeLessThan(commandNames.indexOf('merge-base'))
  })

  it('reports when preparation changes HEAD', async () => {
    let revParseCount = 0
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'fetch' || args[0] === 'rebase') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: 'origin/main\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        revParseCount += 1
        return { stdout: `${revParseCount === 1 ? 'old-head' : 'new-head'}\n`, stderr: '' }
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature\n', stderr: '' }
      }
      if (args[0] === 'merge-base') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'log') {
        return { stdout: '- feat: change\n', stderr: '' }
      }
      if (args[0] === 'diff') {
        return { stdout: 'M\tREADME.md\n', stderr: '' }
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    const context = await getPullRequestDraftContext(execGit, createContextInput())

    expect(context?.branchChangedByPreparation).toBe(true)
  })

  it('keeps a remote-qualified base when the selected base includes the remote', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'fetch' || args[0] === 'rebase') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: 'origin/main\nupstream/main\n', stderr: '' }
      }
      if (args[0] === 'branch') {
        return { stdout: 'feature\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'merge-base') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'log') {
        return { stdout: '- feat: change\n', stderr: '' }
      }
      if (args[0] === 'diff') {
        return { stdout: 'M\tREADME.md\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await getPullRequestDraftContext(execGit, createContextInput('upstream/main'))

    expect(execGit).toHaveBeenCalledWith(['rebase', 'upstream/main'], expect.any(Object))
    expect(execGit).toHaveBeenCalledWith(
      ['merge-base', 'upstream/main', 'HEAD'],
      expect.any(Object)
    )
  })

  it('stops generation when the rebase fails', async () => {
    const execGit = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: 'origin/main\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'rebase') {
        throw new Error('Command failed: git rebase origin/main\nCONFLICT (content): README.md')
      }
      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    await expect(getPullRequestDraftContext(execGit, createContextInput())).rejects.toThrow(
      'Rebase before generating PR details failed: CONFLICT (content): README.md'
    )
    expect(execGit).not.toHaveBeenCalledWith(
      ['merge-base', 'origin/main', 'HEAD'],
      expect.anything()
    )
  })

  it('returns null without running git when the base is invalid', async () => {
    const execGit = vi.fn<GitExec>()

    await expect(getPullRequestDraftContext(execGit, createContextInput('--main'))).resolves.toBe(
      null
    )
    expect(execGit).not.toHaveBeenCalled()
  })
})
