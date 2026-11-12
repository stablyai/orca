import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, expect, it } from 'vitest'
import { createSetupRunnerScript } from './worktree-runner-script'
import type { Repo } from '../../shared/repo-types'

let directory: string | undefined
afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true })
    directory = undefined
  }
})

it('writes usable setup scripts for linked worktrees and rejects non-repositories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-setup-path-'))
  directory = root
  const git = async (args: string[]) => {
    const result = await runProcess({ program: 'git', args, cwd: root })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return result.stdout.trim()
  }
  await git(['init', '-q'])
  await git(['config', 'user.name', 'Setup fixture'])
  await git(['config', 'user.email', 'setup@example.invalid'])
  await git(['config', 'commit.gpgsign', 'false'])
  await git(['config', 'core.hooksPath', ''])
  await git(['commit', '--allow-empty', '-qm', 'fixture'])
  const linked = join(root, 'linked')
  await git(['worktree', 'add', '--detach', linked, 'HEAD'])
  const repo: Repo = {
    id: 'setup-fixture',
    displayName: 'fixture',
    badgeColor: 'blue',
    addedAt: 0,
    path: root
  }
  const result = await createSetupRunnerScript(repo, linked, 'echo SETUP_PATH_OK')
  expect(await readFile(result.runnerScriptPath, 'utf8')).toContain('echo SETUP_PATH_OK')
  const execution = await runProcess({
    program: process.platform === 'win32' ? 'cmd.exe' : 'bash',
    args:
      process.platform === 'win32' ? ['/c', result.runnerScriptPath] : [result.runnerScriptPath],
    cwd: linked
  })
  expect(execution.code).toBe(0)
  expect(execution.stdout).toContain('SETUP_PATH_OK')
  await expect(createSetupRunnerScript(repo, tmpdir(), 'echo UNREACHABLE')).rejects.toThrow()
})
