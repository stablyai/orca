import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneWorktreeCheckoutFiles } from './worktree-checkout-clone'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe.runIf(process.platform === 'darwin')('cloneWorktreeCheckoutFiles', () => {
  let root: string
  let repo: string
  let target: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-checkout-clone-'))
    repo = join(root, 'repo')
    target = join(root, 'target')
    mkdirSync(join(repo, 'src'), { recursive: true })
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'core.autocrlf', 'false')
    git(repo, 'config', 'core.eol', 'lf')
    writeFileSync(join(repo, '.gitattributes'), '*.crlf text eol=crlf\n*.text text\n')
    writeFileSync(join(repo, '.gitignore'), 'secret.env\n')
    writeFileSync(join(repo, 'src/same.txt'), 'same\n')
    writeFileSync(join(repo, 'src/readonly.txt'), 'readonly\n')
    writeFileSync(join(repo, 'edited.txt'), 'committed\n')
    writeFileSync(join(repo, 'windows.crlf'), 'one\n')
    writeFileSync(join(repo, 'normalized.text'), 'two\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
    writeFileSync(join(repo, 'edited.txt'), 'local edit\n')
    writeFileSync(join(repo, 'secret.env'), 'secret\n')
    // Git normalizes this back to the commit, so only a byte comparison sees the difference.
    writeFileSync(join(repo, 'normalized.text'), 'two\r\n')
    chmodSync(join(repo, 'src/readonly.txt'), 0o444)
    // A locked clone refuses chmod, and Git would keep its read-only mode.
    execFileSync('chflags', ['uchg', 'src/readonly.txt'], { cwd: repo })
    execFileSync('xattr', ['-w', 'com.apple.quarantine', '0081;0;Test;', 'src/same.txt'], {
      cwd: repo
    })
    git(repo, 'worktree', 'add', '-q', '--detach', '--no-checkout', target, 'HEAD')
  })

  afterEach(() => {
    execFileSync('chflags', ['-R', 'nouchg', root])
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps only clones identical to what Git would write', async () => {
    await cloneWorktreeCheckoutFiles({
      repoPath: repo,
      worktreePath: target,
      commit: 'HEAD',
      options: { copyOnWriteCheckout: true }
    })
    const cloned = lstatSync(join(target, 'src/same.txt')).ino
    git(target, 'reset', '-q', '--hard', 'HEAD')

    expect(lstatSync(join(target, 'src/same.txt')).ino).toBe(cloned)
    expect(
      execFileSync('xattr', ['src/same.txt'], { cwd: target, encoding: 'utf8' })
    ).not.toContain('com.apple.quarantine')
    expect(lstatSync(join(target, 'src/readonly.txt')).mode & 0o777).toBe(0o644)
    expect(readFileSync(join(target, 'edited.txt'), 'utf8')).toBe('committed\n')
    expect(readFileSync(join(target, 'windows.crlf'), 'utf8')).toBe('one\r\n')
    expect(readFileSync(join(target, 'normalized.text'), 'utf8')).toBe('two\n')
    expect(existsSync(join(target, 'secret.env'))).toBe(false)
    expect(git(target, 'status', '--porcelain', '--ignored')).toBe('')
  })

  it('leaves the checkout to Git when a bare core.autocrlf enables conversion', async () => {
    // A key without a value is true to Git.
    writeFileSync(join(repo, '.git/config'), '[core]\n\tautocrlf\n', { flag: 'a' })
    await cloneWorktreeCheckoutFiles({
      repoPath: repo,
      worktreePath: target,
      commit: 'HEAD',
      options: { copyOnWriteCheckout: true }
    })

    expect(existsSync(join(target, 'src/same.txt'))).toBe(false)
  })
})
