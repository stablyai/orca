import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runGitFixture } from '../../shared/git-process-test-fixture'
import { getBranchCompare, getCommitCompare } from './status'

const tempRoots: string[] = []

describe('Git compares from strict bare repositories', () => {
  let barePath: string
  let baseOid: string
  let headOid: string

  beforeEach(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-bare-compare-'))
    const sourcePath = path.join(root, 'source')
    barePath = path.join(root, 'repo.git')
    tempRoots.push(root)
    await mkdir(sourcePath)
    await runGitFixture(sourcePath, ['init', '--quiet'])
    await writeFile(path.join(sourcePath, 'file.txt'), 'base\n')
    await runGitFixture(sourcePath, ['add', 'file.txt'])
    await runGitFixture(sourcePath, [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test User',
      'commit',
      '--quiet',
      '-m',
      'base'
    ])
    baseOid = (await runGitFixture(sourcePath, ['rev-parse', 'HEAD'])).trim()
    await runGitFixture(sourcePath, ['branch', 'base', baseOid])
    await writeFile(path.join(sourcePath, 'file.txt'), 'head\n')
    await runGitFixture(sourcePath, [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test User',
      'commit',
      '--quiet',
      '-am',
      'head'
    ])
    headOid = (await runGitFixture(sourcePath, ['rev-parse', 'HEAD'])).trim()
    await runGitFixture(root, ['clone', '--bare', '--quiet', sourcePath, barePath])
    barePath = await realpath(barePath)
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'safe.bareRepository')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'explicit')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('loads commit metadata before reading the selected diff', async () => {
    const result = await getCommitCompare(barePath, headOid)

    expect(result.summary).toMatchObject({
      commitOid: headOid,
      parentOid: baseOid,
      status: 'ready',
      changedFiles: 1
    })
    expect(result.entries).toEqual([{ path: 'file.txt', status: 'modified', added: 1, removed: 1 }])
  })

  it('loads branch metadata before reading the selected diff', async () => {
    const result = await getBranchCompare(barePath, 'refs/heads/base')

    expect(result.summary).toMatchObject({
      baseOid,
      headOid,
      mergeBase: baseOid,
      status: 'ready',
      changedFiles: 1,
      commitsAhead: 1,
      commitsBehind: 0
    })
    expect(result.entries).toEqual([{ path: 'file.txt', status: 'modified', added: 1, removed: 1 }])
  })
})
