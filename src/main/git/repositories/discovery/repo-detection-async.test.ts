import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as gitExecFileModule from '../../command-runner/git-exec-file'
import { runProcess } from '@orca/process-host'
import { getGitRepoRootAsync, isGitRepoAsync } from './repo-detection'

let fixture: string
async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess({ program: 'git', args, cwd, timeoutMs: 15_000 })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'orca-repo-async-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(fixture, { recursive: true, force: true })
})

describe('asynchronous repository detection with real Git', () => {
  it('preserves genuine metadata fallback when asynchronous Git cannot answer', async () => {
    const repo = join(fixture, 'fallback repo')
    const nested = join(repo, 'packages')
    mkdirSync(nested, { recursive: true })
    await git(repo, ['init', '--quiet'])
    vi.spyOn(gitExecFileModule, 'gitExecFileAsync').mockRejectedValue(new Error('Git unavailable'))
    expect(await isGitRepoAsync(nested)).toBe(true)
    expect(await getGitRepoRootAsync(nested)).toBe(repo.replaceAll('\\', '/'))
    expect(await isGitRepoAsync(join(repo, '.git'))).toBe(false)
  })
})
