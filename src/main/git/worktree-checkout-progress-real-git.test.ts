import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCheckoutProgress } from '../../shared/worktree/create-types'
import { gitExecFileAsync } from './runner'
import { addWorktree } from './worktree'

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

async function captureFailure(
  run: () => Promise<unknown>
): Promise<{ message: string; stderr: unknown }> {
  try {
    await run()
  } catch (error) {
    if (error instanceof Error) {
      return { message: error.message, stderr: 'stderr' in error ? error.stderr : undefined }
    }
  }
  throw new Error('expected the create to fail with an Error')
}

describe('checkout progress from a real `git worktree add`', () => {
  it('reports rising progress through 100% and then the end of the checkout', async () => {
    // Emit progress before this small checkout finishes, bypassing Git's initial delay.
    vi.stubEnv('GIT_PROGRESS_DELAY', '0')
    const reports: (WorktreeCheckoutProgress | null)[] = []

    await addWorktree(repo, join(root, 'feature'), 'feature', 'main', false, false, {
      onCheckoutProgress: (progress) => reports.push(progress)
    })

    const meter = reports.filter((progress) => progress !== null)
    expect(reports.at(-1)).toBeNull()
    expect(meter).toHaveLength(reports.length - 1)
    expect(meter.length).toBeGreaterThan(0)
    expect(meter.at(-1)).toEqual({ percent: 100, completed: FILE_COUNT, total: FILE_COUNT })
    expect(meter.every((progress) => progress.total === FILE_COUNT)).toBe(true)
    const percents = meter.map((progress) => progress.percent)
    expect(percents).toEqual([...percents].sort((left, right) => left - right))
    expect(new Set(percents).size).toBe(percents.length)
  })

  it('fails with the same error and stderr whether or not progress is observed', async () => {
    vi.stubEnv('GIT_PROGRESS_DELAY', '0')
    const occupied = join(root, 'occupied')
    await mkdir(occupied)
    await writeFile(join(occupied, 'keep.txt'), 'keep\n')
    const onCheckoutProgress = vi.fn()

    const unobserved = await captureFailure(() =>
      addWorktree(repo, occupied, 'blocked', 'main', false, false)
    )
    await gitExecFileAsync(['branch', '-D', 'blocked'], { cwd: repo }).catch(() => {})
    const observed = await captureFailure(() =>
      addWorktree(repo, occupied, 'blocked', 'main', false, false, { onCheckoutProgress })
    )

    expect(observed.message).toBe(unobserved.message)
    expect(observed.stderr).toBe(unobserved.stderr)
    expect(observed.message).toContain('already exists')
    expect(onCheckoutProgress).not.toHaveBeenCalled()
  })

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
