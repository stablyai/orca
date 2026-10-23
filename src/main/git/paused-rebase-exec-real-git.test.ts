import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { buildResolveConflictsPrompt } from '../../shared/source-control-conflict-prompts'

it('recovers a failed rebase exec by amending its fix before continuing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-paused-rebase-exec-'))
  const git = async (args: string[]) => {
    const result = await runProcess({
      program: 'git',
      args,
      cwd: directory,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(directory, 'missing-config'),
        GIT_AUTHOR_NAME: 'Recovery Test',
        GIT_AUTHOR_EMAIL: 'recovery@example.invalid',
        GIT_COMMITTER_NAME: 'Recovery Test',
        GIT_COMMITTER_EMAIL: 'recovery@example.invalid',
        GIT_EDITOR: 'true'
      },
      timeoutMs: 10_000
    })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return result.stdout.trim()
  }
  try {
    const prompt = buildResolveConflictsPrompt({
      conflictOperation: 'rebase',
      worktreePath: directory,
      entries: []
    })
    expect(prompt).toContain('git commit --amend --no-edit')
    expect(prompt).toContain('index contains only this fix')
    expect(prompt).not.toContain('Do not push or create unrelated/manual commits')
    await git(['init', '-q'])
    await git(['config', 'core.hooksPath', '.git/no-hooks'])
    await writeFile(join(directory, 'example.txt'), 'base\n')
    await git(['add', 'example.txt'])
    await git(['commit', '-qm', 'Base'])
    await writeFile(join(directory, 'example.txt'), 'change\n')
    await git(['commit', '-qam', 'Change'])
    const execCommand = ['grep', '-q', 'fixed', 'HEAD', '--', 'example.txt']
    await expect(
      git(['rebase', '--exec', `git ${execCommand.join(' ')}`, 'HEAD~1'])
    ).rejects.toThrow('execution failed')
    await writeFile(join(directory, 'example.txt'), 'fixed\n')
    await git(['add', 'example.txt'])
    await expect(git(['rebase', '--continue'])).rejects.toThrow('commit')
    await git(['commit', '--amend', '--no-edit'])
    await git(execCommand)
    await git(['rebase', '--continue'])
    expect(await git(['status', '--porcelain'])).toBe('')
    expect(await git(['rev-list', '--count', 'HEAD'])).toBe('2')
    expect(await git(['show', 'HEAD:example.txt'])).toBe('fixed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
