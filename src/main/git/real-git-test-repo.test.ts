import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureRealGitTestRepo } from './real-git-test-repo'

let root: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-real-git-test-repo-'))
  // A developer config that signs every commit and tag, through a signer that does not exist,
  // so a signing attempt fails without running any real signing program.
  const globalConfig = join(root, 'global.gitconfig')
  writeFileSync(
    globalConfig,
    [
      '[commit]',
      '\tgpgsign = true',
      '[tag]',
      '\tgpgsign = true',
      '[gpg]',
      // Forward slashes: a backslash starts an escape in a gitconfig value.
      `\tprogram = ${join(root, 'missing-signer').replaceAll('\\', '/')}`,
      ''
    ].join('\n')
  )
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('configureRealGitTestRepo', () => {
  it('commits and tags without the developer signing config', () => {
    const unconfigured = join(root, 'unconfigured')
    git(root, ['init', '--quiet', unconfigured])
    git(unconfigured, ['config', 'user.name', 'Test'])
    git(unconfigured, ['config', 'user.email', 'test@example.invalid'])
    // Control: the global config really demands signing here.
    expect(() => git(unconfigured, ['commit', '--quiet', '--allow-empty', '-m', 'x'])).toThrow()

    const repo = join(root, 'repo')
    git(root, ['init', '--quiet', repo])
    configureRealGitTestRepo(repo, { name: 'Test', email: 'test@example.invalid' })
    git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'fixture'])
    git(repo, ['tag', 'v1.0.0'])

    expect(git(repo, ['cat-file', '-p', 'HEAD'])).not.toContain('gpgsig')
    // A lightweight tag names the commit itself; a signed tag would be a tag object.
    expect(git(repo, ['cat-file', '-t', 'v1.0.0']).trim()).toBe('commit')
    expect(git(repo, ['log', '-1', '--format=%an <%ae>']).trim()).toBe(
      'Test <test@example.invalid>'
    )
  })
})
