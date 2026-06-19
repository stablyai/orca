import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'
import { RelayContext } from './context'
import { GitHandler } from './git-handler'
import {
  createMockDispatcher,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'

describe('GitHandler pull reconciliation', () => {
  let dispatcher: MockDispatcher
  let tmpDir: string
  let gitEnv: NodeJS.ProcessEnv
  let previousGitConfigGlobal: string | undefined
  let previousGitConfigNosystem: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-git-pull-reconciliation-'))
    const globalGitConfigPath = path.join(tmpDir, 'global-gitconfig')
    writeFileSync(globalGitConfigPath, '')
    previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL
    previousGitConfigNosystem = process.env.GIT_CONFIG_NOSYSTEM
    process.env.GIT_CONFIG_GLOBAL = globalGitConfigPath
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalGitConfigPath,
      GIT_CONFIG_NOSYSTEM: '1'
    }
    dispatcher = createMockDispatcher()
    const ctx = new RelayContext()
    new GitHandler(dispatcher as unknown as RelayDispatcher, ctx)
  })

  afterEach(async () => {
    restoreGitEnv('GIT_CONFIG_GLOBAL', previousGitConfigGlobal)
    restoreGitEnv('GIT_CONFIG_NOSYSTEM', previousGitConfigNosystem)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  function execGit(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: gitEnv,
      stdio: 'pipe'
    })
  }

  function configureIdentity(cwd: string): void {
    execGit(cwd, ['config', 'user.email', 'test@test.com'])
    execGit(cwd, ['config', 'user.name', 'Test'])
  }

  function commitAll(cwd: string, message: string): void {
    execGit(cwd, ['add', '.'])
    execGit(cwd, ['commit', '-m', message])
  }

  function createDivergentFixture(): string {
    const bareDir = path.join(tmpDir, 'origin.git')
    const consumerDir = path.join(tmpDir, 'consumer')
    const producerDir = path.join(tmpDir, 'producer')

    execGit(tmpDir, ['init', '--bare', bareDir])
    execGit(tmpDir, ['clone', bareDir, consumerDir])
    configureIdentity(consumerDir)
    writeFileSync(path.join(consumerDir, 'base.txt'), 'base\n')
    commitAll(consumerDir, 'initial')
    execGit(consumerDir, ['push', '--set-upstream', 'origin', 'HEAD'])

    execGit(tmpDir, ['clone', bareDir, producerDir])
    configureIdentity(producerDir)
    writeFileSync(path.join(producerDir, 'remote.txt'), 'remote\n')
    commitAll(producerDir, 'remote')
    execGit(producerDir, ['push'])

    writeFileSync(path.join(consumerDir, 'local.txt'), 'local\n')
    commitAll(consumerDir, 'local')

    return consumerDir
  }

  it('explains how to configure a pull policy when divergent branches have no strategy', async () => {
    const consumerDir = createDivergentFixture()

    await expect(dispatcher.callRequest('git.pull', { worktreePath: consumerDir })).rejects.toThrow(
      'Pull needs a Git pull policy for divergent branches. Configure one for this repository'
    )

    expect(execGit(consumerDir, ['status', '--short'])).toBe('')
  })

  it('preserves configured rebase pull semantics', async () => {
    const consumerDir = createDivergentFixture()
    execGit(consumerDir, ['config', 'pull.rebase', 'true'])

    await expect(
      dispatcher.callRequest('git.pull', { worktreePath: consumerDir })
    ).resolves.not.toThrow()

    const parentRefs = execGit(consumerDir, ['log', '-1', '--pretty=%P']).trim().split(/\s+/)
    expect(parentRefs).toHaveLength(1)
    expect(existsSync(path.join(consumerDir, 'remote.txt'))).toBe(true)
    expect(execGit(consumerDir, ['status', '--short'])).toBe('')
  })
})

function restoreGitEnv(
  name: 'GIT_CONFIG_GLOBAL' | 'GIT_CONFIG_NOSYSTEM',
  value: string | undefined
): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}
