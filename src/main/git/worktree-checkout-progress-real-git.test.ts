import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCheckoutProgress } from '../../shared/worktree/create-types'
import { gitExecFileAsync } from './runner'
import { addWorktree } from './worktree'
import type * as WorktreeCheckoutProgressModule from './worktree-checkout-progress'

const observedStderrChunks = vi.hoisted((): string[] => [])

// Records every stderr chunk the create's observer receives, then delegates unchanged.
vi.mock('./worktree-checkout-progress', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeCheckoutProgressModule>()
  return {
    ...actual,
    createWorktreeCheckoutProgressReader: (
      ...args: Parameters<typeof actual.createWorktreeCheckoutProgressReader>
    ) => {
      const reader = actual.createWorktreeCheckoutProgressReader(...args)
      return {
        ...reader,
        read: (chunk: string) => {
          observedStderrChunks.push(chunk)
          reader.read(chunk)
        }
      }
    }
  }
})

const FILE_COUNT = 150

let root = ''
let repo = ''

beforeEach(async () => {
  observedStderrChunks.length = 0
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

// Why: git's one-second tick can add a same-percent record to one run only, so compare without records.
function withoutProgressRecords(text: unknown): string {
  return String(text)
    .split(/[\r\n]/)
    .filter((line) => !line.startsWith('Updating files:'))
    .join('\n')
}

describe('checkout progress from a real `git worktree add`', () => {
  it('reports rising progress through 100% and then the end of the checkout', async () => {
    // Why: without it git waits ~1 s before its first record, longer than this checkout.
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

  it('reports nothing for a --no-checkout add, which writes no files', async () => {
    vi.stubEnv('GIT_PROGRESS_DELAY', '0')
    const onCheckoutProgress = vi.fn()

    await addWorktree(repo, join(root, 'sparse'), 'sparse', 'main', false, true, {
      onCheckoutProgress
    })

    expect(onCheckoutProgress).not.toHaveBeenCalled()
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
    // Same branch name both times, so the texts are comparable byte for byte.
    await gitExecFileAsync(['branch', '-D', 'blocked'], { cwd: repo }).catch(() => {})
    const observed = await captureFailure(() =>
      addWorktree(repo, occupied, 'blocked', 'main', false, false, { onCheckoutProgress })
    )

    expect(observed.message).toBe(unobserved.message)
    expect(observed.stderr).toBe(unobserved.stderr)
    expect(observed.message).toContain('already exists')
    expect(onCheckoutProgress).not.toHaveBeenCalled()
  })

  it('leaves the error and stderr unchanged when git printed progress before failing', async () => {
    vi.stubEnv('GIT_PROGRESS_DELAY', '0')
    // The last file in checkout order goes through a required smudge filter that fails.
    await writeFile(join(repo, '.gitattributes'), 'zzz-last.txt filter=failing\n')
    await writeFile(join(repo, 'zzz-last.txt'), 'last\n')
    await gitExecFileAsync(['add', '.'], { cwd: repo })
    await gitExecFileAsync(
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'filter'],
      { cwd: repo }
    )
    // Why: reads its input first so git never races a closed pipe into different stderr.
    await gitExecFileAsync(['config', 'filter.failing.smudge', 'cat >/dev/null; false'], {
      cwd: repo
    })
    await gitExecFileAsync(['config', 'filter.failing.required', 'true'], { cwd: repo })
    const target = join(root, 'filtered')
    const reports: (WorktreeCheckoutProgress | null)[] = []

    const unobserved = await captureFailure(() =>
      addWorktree(repo, target, 'filtered', 'main', false, false)
    )
    // Git removes the half-made worktree but keeps the branch it created.
    await gitExecFileAsync(['branch', '-D', 'filtered'], { cwd: repo })
    const observed = await captureFailure(() =>
      addWorktree(repo, target, 'filtered', 'main', false, false, {
        onCheckoutProgress: (progress) => reports.push(progress)
      })
    )

    // The observer saw exactly the stderr the error carries, byte for byte.
    expect(observed.stderr).toBe(observedStderrChunks.join(''))
    expect(withoutProgressRecords(observed.message)).toBe(
      withoutProgressRecords(unobserved.message)
    )
    expect(withoutProgressRecords(observed.stderr)).toBe(withoutProgressRecords(unobserved.stderr))
    expect(observed.message).toContain('smudge filter failing failed')
    expect(observed.stderr).toContain('Updating files:')
    expect(reports.some((progress) => progress !== null)).toBe(true)
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

    // The first throw detaches the observer; git's checkout is unaffected.
    expect(onCheckoutProgress).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'git stderr observer failed; detaching it',
      expect.objectContaining({ message: 'listener failed' })
    )
    const { stdout } = await gitExecFileAsync(['worktree', 'list', '--porcelain'], { cwd: repo })
    expect(stdout).toContain('branch refs/heads/resilient')
  })

  it('refuses a stderr observer on the termination-barrier path instead of ignoring it', async () => {
    await expect(
      gitExecFileAsync(['--version'], {
        cwd: repo,
        terminationBarrier: true,
        onStderr: () => {}
      })
    ).rejects.toThrow('onStderr is not supported with terminationBarrier.')
  })
})
