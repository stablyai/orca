/**
 * The relay's git.exec must carry the fork-PR remote setup that SSH worktree
 * creation performs: adding the contributor's fork as a remote, and dropping it
 * again when the last worktree using it is removed.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { gitInit, type MockDispatcher } from './git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
  removeGitTempDir
} from './git-handler-test-harness'

const FORK_REMOTE = 'pr-contributor-orca'
const FORK_URL = 'https://github.com/contributor/orca.git'

describe('GitHandler git.exec fork remote', () => {
  let dispatcher: MockDispatcher
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createGitTempDir()
    ;({ dispatcher } = createGitHandlerRelay())
    gitInit(tmpDir)
  })

  afterEach(async () => {
    await removeGitTempDir(tmpDir)
  })

  function configuredRemotes(): string {
    return execFileSync('git', ['remote'], { cwd: tmpDir, encoding: 'utf-8' }).trim()
  }

  it('adds and removes the fork remote', async () => {
    await dispatcher.callRequest('git.exec', {
      args: ['remote', 'add', FORK_REMOTE, FORK_URL],
      cwd: tmpDir
    })
    expect(configuredRemotes()).toBe(FORK_REMOTE)

    const url = (await dispatcher.callRequest('git.exec', {
      args: ['remote', 'get-url', FORK_REMOTE],
      cwd: tmpDir
    })) as { stdout: string }
    expect(url.stdout.trim()).toBe(FORK_URL)

    await dispatcher.callRequest('git.exec', {
      args: ['remote', 'remove', FORK_REMOTE],
      cwd: tmpDir
    })
    expect(configuredRemotes()).toBe('')
  })

  it('still refuses to repoint an existing remote', async () => {
    await expect(
      dispatcher.callRequest('git.exec', {
        args: ['remote', 'set-url', 'origin', FORK_URL],
        cwd: tmpDir
      })
    ).rejects.toThrow('Destructive git remote operations are not allowed via exec')
  })
})
