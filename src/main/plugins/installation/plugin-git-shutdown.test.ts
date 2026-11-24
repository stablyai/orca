import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
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
  const startedAt = Date.now()
  let settled = false
  const running = runPluginGit(['-c', 'alias.hang=!sleep 30', 'hang'], cwd).finally(() => {
    settled = true
  })
  await new Promise((resolve) => setTimeout(resolve, 1000))

  expect(settled).toBe(false)
  abortPluginGitForShutdown()

  await expect(running).rejects.toThrow()
  expect(Date.now() - startedAt).toBeLessThan(10_000)
  await expect(runPluginGit(['--version'], cwd)).rejects.toThrow()
})
