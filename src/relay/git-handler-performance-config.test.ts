/**
 * The relay plans and writes repository Git tuning host-side; the client only
 * names the repository and the action.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitInit, type MockDispatcher } from './git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
  removeGitTempDir
} from './git-handler-test-harness'
import { parseGitPerformanceConfigResult } from '../shared/git-performance-config-wire'

describe('GitHandler git.repoPerformanceConfig', () => {
  let dispatcher: MockDispatcher
  let tmpDir: string
  let savedGlobal: string | undefined

  beforeEach(() => {
    tmpDir = createGitTempDir()
    savedGlobal = process.env.GIT_CONFIG_GLOBAL
    const globalConfig = join(tmpDir, 'global.gitconfig')
    writeFileSync(globalConfig, '[checkout]\n\tworkers = 2\n')
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    ;({ dispatcher } = createGitHandlerRelay())
    gitInit(tmpDir)
  })

  afterEach(async () => {
    if (savedGlobal === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL
    } else {
      process.env.GIT_CONFIG_GLOBAL = savedGlobal
    }
    await removeGitTempDir(tmpDir)
  })

  function localValue(key: string): string | null {
    try {
      return execFileSync('git', ['config', '--local', '--get', key], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
    } catch {
      return null
    }
  }

  it('applies, reports and reverts through one narrow method', async () => {
    const applied = parseGitPerformanceConfigResult(
      await dispatcher.callRequest('git.repoPerformanceConfig', {
        repoPath: tmpDir,
        action: 'apply'
      })
    )
    expect(applied.plan?.find((entry) => entry.key === 'checkout.workers')).toEqual({
      key: 'checkout.workers',
      action: 'skip',
      reason: 'set-by-user'
    })
    expect(localValue('fetch.writeCommitGraph')).toBe('true')
    expect(applied.state.userKeys).toEqual(['checkout.workers'])

    const inspected = parseGitPerformanceConfigResult(
      await dispatcher.callRequest('git.repoPerformanceConfig', {
        repoPath: tmpDir,
        action: 'inspect'
      })
    )
    expect(inspected.state).toEqual(applied.state)

    await dispatcher.callRequest('git.repoPerformanceConfig', {
      repoPath: tmpDir,
      action: 'revert',
      keys: ['fetch.writeCommitGraph']
    })
    expect(localValue('fetch.writeCommitGraph')).toBeNull()
    expect(localValue('orca.performanceConfig')).not.toBeNull()

    await dispatcher.callRequest('git.repoPerformanceConfig', {
      repoPath: tmpDir,
      action: 'revert'
    })
    expect(localValue('orca.performanceConfig')).toBeNull()
  })

  it.each([
    [{ repoPath: '', action: 'apply' }, 'Invalid repository performance config request.'],
    [{ repoPath: 'a\0b', action: 'apply' }, 'Invalid repository performance config request.'],
    [{ action: 'apply' }, 'Invalid repository performance config request.'],
    [{ repoPath: '/tmp', action: 'exec' }, 'Unknown repository performance config action.'],
    [
      { repoPath: '/tmp', action: 'apply', fsmonitor: 'yes' },
      'Invalid repository performance config request.'
    ],
    [
      { repoPath: '/tmp', action: 'revert', keys: ['core.editor'] },
      'Invalid repository performance config request.'
    ]
  ])('rejects %j', async (params, message) => {
    await expect(dispatcher.callRequest('git.repoPerformanceConfig', params)).rejects.toThrow(
      message
    )
  })
})
