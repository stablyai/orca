import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from './git/runner'
import { writeIssueCommand } from './issue-command-file'

describe('issue command ignore rules', () => {
  let root: string
  let repo: string
  let globalConfig: string

  const git = (args: string[]) => gitExecFileAsync(args, { cwd: repo })

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-issue-ignore-'))
    repo = join(root, 'repo with spaces')
    mkdirSync(repo)
    globalConfig = join(root, 'gitconfig')
    const globalIgnore = join(root, 'ignore')
    writeFileSync(globalConfig, '')
    writeFileSync(globalIgnore, '')
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    await git(['init', '-q'])
    await git(['config', '--file', globalConfig, 'core.excludesFile', globalIgnore])
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  it.each(['.orca', '.orca/', '/.orca/', '.orca/*', '.orca/issue-command'])(
    'respects global ignore pattern %s',
    async (pattern) => {
      writeFileSync(join(root, 'ignore'), `${pattern}\n`)
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')

      await writeIssueCommand(repo, 'local command')

      expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules/\n')
      expect(readFileSync(join(repo, '.orca', 'issue-command'), 'utf8')).toBe('local command\n')
    }
  )

  it('does not create .gitignore when the repository exclude already ignores .orca', async () => {
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '.orca/\n')

    await writeIssueCommand(repo, 'local command')

    expect(existsSync(join(repo, '.gitignore'))).toBe(false)
    expect((await git(['status', '--porcelain'])).stdout).toBe('')
  })

  it('respects anchored repository rules', async () => {
    writeFileSync(join(repo, '.gitignore'), '/.orca/\n')

    await writeIssueCommand(repo, 'local command')

    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('/.orca/\n')
  })

  it('creates .gitignore when no ignore rules exist', async () => {
    await writeIssueCommand(repo, 'local command')

    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('.orca\n')
  })

  it('respects shared repository excludes from a linked worktree', async () => {
    await git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-qm',
      'initial'
    ])
    const worktree = join(root, 'linked worktree')
    await git(['worktree', 'add', '-q', '-b', 'issue-command-test', worktree])
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '.orca/\n')

    await writeIssueCommand(worktree, 'local command')

    expect(existsSync(join(worktree, '.gitignore'))).toBe(false)
    expect((await gitExecFileAsync(['status', '--porcelain'], { cwd: worktree })).stdout).toBe('')
  })

  it('adds the rule once when .orca is not ignored', async () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules/')

    await writeIssueCommand(repo, 'first command')
    await writeIssueCommand(repo, 'second command')

    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules/\n.orca\n')
    expect(readFileSync(join(repo, '.orca', 'issue-command'), 'utf8')).toBe('second command\n')
  })

  it('honors a repository rule that negates a global ignore', async () => {
    writeFileSync(join(root, 'ignore'), '.orca/\n')
    writeFileSync(join(repo, '.gitignore'), '!.orca/\n')

    await writeIssueCommand(repo, 'local command')

    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('!.orca/\n.orca\n')
  })
})
