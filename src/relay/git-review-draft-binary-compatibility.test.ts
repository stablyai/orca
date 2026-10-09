import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '../shared/child-process/run-process'
import {
  createGitHandlerRelay,
  createGitTempDir,
  removeGitTempDir
} from './git-handler-test-harness'

const binary = process.env.ORCA_GIT_COMPAT_BINARY
const image = process.env.ORCA_GIT_COMPAT_IMAGE
const expectedVersion = process.env.ORCA_GIT_COMPAT_VERSION
const dockerUser =
  typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? ['--user', `${process.getuid()}:${process.getgid()}`]
    : []

describe.skipIf(!binary && !image)('review draft real Git compatibility', () => {
  let fixturePath = ''
  let fixtureCwd = ''

  async function git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const result = await runProcess({
      program: image ? 'docker' : (binary ?? 'git'),
      args: image
        ? [
            'run',
            '--rm',
            '--network=none',
            ...dockerUser,
            '-v',
            `${fixturePath}:/repo`,
            '-w',
            '/repo',
            image,
            '-c',
            'safe.directory=/repo',
            ...args
          ]
        : args,
      cwd: fixturePath,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        GIT_EXEC_PATH: process.env.GIT_EXEC_PATH,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0'
      },
      timeoutMs: 30_000,
      maxOutputBytes: 2 * 1024 * 1024
    })
    if (result.code !== 0 || result.signal || result.timedOut || result.outputTruncated) {
      throw new Error(result.stderr || 'Git compatibility command failed.')
    }
    return { stdout: result.stdout, stderr: result.stderr }
  }

  beforeAll(async () => {
    fixturePath = createGitTempDir()
    fixtureCwd = image ? '/repo' : fixturePath
    expect((await git(['--version'])).stdout).toContain(`git version ${expectedVersion}`)
  })
  afterAll(async () => {
    if (fixturePath) {
      await removeGitTempDir(fixturePath)
    }
  })
  it('reads complete review drafts through the relay fixed diff formats', async () => {
    await git(['init', '-q'])
    await git(['config', 'user.name', 'Review Compatibility'])
    await git(['config', 'user.email', 'review@example.invalid'])
    await writeFile(join(fixturePath, 'evidence.txt'), 'before\n')
    await git(['add', 'evidence.txt'])
    await git(['commit', '-qm', 'initial'])
    const mergeBase = (await git(['rev-parse', 'HEAD'])).stdout.trim()
    await writeFile(join(fixturePath, 'evidence.txt'), 'after\n')
    await git(['commit', '-qam', 'review evidence'])
    const before = (await git(['status', '--porcelain'])).stdout
    const { dispatcher, handler } = createGitHandlerRelay()
    Object.assign(handler, { git })
    try {
      await expect(
        dispatcher.callRequest('git.reviewDiff', {
          worktreePath: fixtureCwd,
          mergeBase,
          format: 'name-status'
        })
      ).resolves.toEqual({ stdout: 'M\tevidence.txt\n', stderr: '' })
      const patch = await dispatcher.callRequest('git.reviewDiff', {
        worktreePath: fixtureCwd,
        mergeBase,
        format: 'patch'
      })
      expect(patch).toMatchObject({ stdout: expect.stringContaining('-before\n+after\n') })
      expect((await git(['status', '--porcelain'])).stdout).toBe(before)
    } finally {
      handler.dispose()
    }
  })
})
