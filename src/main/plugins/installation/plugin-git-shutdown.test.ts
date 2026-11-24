import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDirs } from '../../../shared/testing/remove-temp-dirs.test-support'
import { abortPluginGitForShutdown, runPluginGit } from './plugin-git-repository'

const roots: string[] = []
afterEach(async () => {
  await removeTempDirs(roots.splice(0))
})

// Own file: the shutdown abort is process-wide and permanent.
it('stops running plugin Git on quit and refuses to start more', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'orca-plugin-git-shutdown-test-'))
  roots.push(cwd)
  // A 30 s child: without the abort this test exceeds its default timeout.
  const running = runPluginGit(['-c', 'alias.hang=!touch started && sleep 30', 'hang'], cwd)
  running.catch(() => undefined)
  await vi.waitFor(() => access(join(cwd, 'started')), { timeout: 4000 })

  abortPluginGitForShutdown()

  await expect(running).rejects.toThrow()
  await expect(runPluginGit(['--version'], cwd)).rejects.toThrow()
})
