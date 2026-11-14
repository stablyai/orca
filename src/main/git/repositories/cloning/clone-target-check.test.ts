import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { checkCloneTarget } from './clone-target-check'
import { getClonePathComparisonKey } from './repo-clone-path'

const roots: string[] = []

function parentFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-clone-target-'))
  roots.push(root)
  return root
}

function savedClone(path: string, originUrl: string): Repo {
  execFileSync('git', ['init', '-q', path])
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', originUrl])
  execFileSync('git', [
    '-C',
    path,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  ])
  return {
    id: path,
    path,
    displayName: 'orca-plugins',
    badgeColor: '#fff',
    addedAt: 1,
    kind: 'git'
  }
}

const check = (repos: Repo[], url: string, destination: string) =>
  checkCloneTarget(
    { url, destination },
    (keys) => repos.find((repo) => keys.includes(getClonePathComparisonKey(repo.path))),
    LOCAL_EXECUTION_HOST_ID
  )

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('checkCloneTarget', () => {
  it('suggests an owner-named folder when a same-named repository from another owner is there', async () => {
    const parent = parentFolder()
    const official = savedClone(
      join(parent, 'orca-plugins'),
      'https://github.com/stablyai/orca-plugins.git'
    )

    await expect(
      check([official], 'https://github.com/aamonnaig4/orca-plugins', parent)
    ).resolves.toEqual({
      status: 'taken',
      folderName: 'orca-plugins',
      reason: 'other-repository',
      suggestedFolderName: 'orca-plugins-aamonnaig4'
    })

    mkdirSync(join(parent, 'orca-plugins-aamonnaig4'))
    writeFileSync(join(parent, 'orca-plugins-aamonnaig4', 'notes.txt'), '')
    await expect(
      check([official], 'git@github.com:aamonnaig4/orca-plugins.git', parent)
    ).resolves.toMatchObject({ status: 'taken', suggestedFolderName: 'orca-plugins-2' })
  })

  it('leaves the default folder alone when it already holds this repository', async () => {
    const parent = parentFolder()
    const official = savedClone(
      join(parent, 'orca-plugins'),
      'https://github.com/stablyai/orca-plugins.git'
    )

    await expect(
      check([official], 'git@github.com:stablyai/orca-plugins.git', parent)
    ).resolves.toEqual({ status: 'free', folderName: 'orca-plugins' })
  })
})
