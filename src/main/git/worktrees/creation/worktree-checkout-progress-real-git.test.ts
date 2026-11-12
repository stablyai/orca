import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { addWorktree } from './worktree-add'

const FILE_COUNT = 150

let root = ''
let repo = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-checkout-progress-'))
  repo = join(root, 'repo')
  await gitExecFileAsync(['init', '--quiet', repo], { cwd: root })
  await gitExecFileAsync(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo })
  await Promise.all(
    Array.from({ length: FILE_COUNT }, (_, index) =>
      writeFile(join(repo, `file-${index}.txt`), `${index}\n`)
    )
  )
  await gitExecFileAsync(['add', '.'], { cwd: repo })
  await gitExecFileAsync(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'],
    { cwd: repo }
  )
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('checkout progress from a real `git worktree add`', () => {
  it('still creates the worktree when the progress listener throws', async () => {
    vi.stubEnv('GIT_PROGRESS_DELAY', '0')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onCheckoutProgress = vi.fn(() => {
      throw new Error('listener failed')
    })

    await addWorktree(repo, join(root, 'resilient'), 'resilient', 'main', false, false, {
      onCheckoutProgress
    })

    expect(onCheckoutProgress).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'git stderr observer failed; detaching it',
      expect.objectContaining({ message: 'listener failed' })
    )
    const { stdout } = await gitExecFileAsync(['worktree', 'list', '--porcelain'], { cwd: repo })
    expect(stdout).toContain('branch refs/heads/resilient')
  })
})
