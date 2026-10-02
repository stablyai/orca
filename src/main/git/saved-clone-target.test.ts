import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import { reuseSavedCloneTarget } from './saved-clone-target'

const url = 'https://github.com/stablyai/orca.git'
const roots: string[] = []

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args])
}

// What `git clone url` leaves at <root>/orca. `finished: false` is a clone killed before checkout;
// `commits: false` is a finished clone of an empty repository, whose HEAD stays unborn.
function checkout(originUrl: string, { finished = true, commits = true } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-saved-clone-target-'))
  roots.push(root)
  const path = join(root, 'orca')
  execFileSync('git', ['init', '-q', path])
  git(path, 'remote', 'add', 'origin', originUrl)
  if (!finished) {
    writeFileSync(join(path, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n')
  } else if (commits) {
    git(path, 'commit', '-q', '--allow-empty', '-m', 'init')
  }
  return path
}

function saved(path: string, extra: Partial<Repo> = {}): Repo {
  return {
    id: 'saved',
    path,
    displayName: 'orca',
    badgeColor: '#fff',
    addedAt: 1,
    kind: 'git',
    ...extra
  }
}

const decide = (project: Repo, requested = url) =>
  reuseSavedCloneTarget(() => project, requested, LOCAL_EXECUTION_HOST_ID)

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('reuseSavedCloneTarget', () => {
  it('reuses a saved project whose folder is a finished clone of the URL', async () => {
    const project = saved(checkout(url))
    await expect(decide(project)).resolves.toBe(project)
  })

  it('reuses a finished clone of the same repo spelled differently', async () => {
    const project = saved(checkout('git@github.com:stablyai/orca.git'))
    await expect(decide(project, 'https://github.com/stablyai/orca')).resolves.toBe(project)
  })

  // A brand-new repository has no commits, so a repeat clone must not read as a failed one.
  it('reuses a finished clone of an empty repository, whose HEAD is unborn', async () => {
    const project = saved(checkout(url, { commits: false }))
    await expect(decide(project)).resolves.toBe(project)
  })

  it('reuses a finished clone left on a detached HEAD', async () => {
    const path = checkout(url)
    git(path, 'checkout', '-q', '--detach')
    const project = saved(path)
    await expect(decide(project)).resolves.toBe(project)
  })

  it('does not reuse a folder nested inside a clone of an empty repository', async () => {
    const nested = join(checkout(url, { commits: false }), 'orca')
    mkdirSync(nested)
    await expect(decide(saved(nested))).rejects.toThrow('already an Orca project')
  })

  it('refuses a finished clone of a different URL with the same folder name', async () => {
    const project = saved(checkout('https://github.com/me/orca.git'))
    await expect(decide(project)).rejects.toThrow('"orca" is already an Orca project')
  })

  // The two reasons a clone can be refused need different things from the user, so say which it is.
  it('names the repository it has on record when the project was a different one', async () => {
    const project = saved(join(tmpdir(), 'orca-saved-clone-target-absent'), {
      gitRemoteIdentity: {
        canonicalKey: 'github.com/someone/orca',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/someone/orca.git'
      }
    })
    await expect(decide(project)).rejects.toThrow('recorded as https://github.com/someone/orca.git')
  })

  it('says it has no record of the repository when the project never stored an origin', async () => {
    const project = saved(join(tmpdir(), 'orca-saved-clone-target-absent'))
    await expect(decide(project)).rejects.toThrow('no record of which repository')
  })

  it('refuses a finished clone of a different local path, which does not normalize', async () => {
    const project = saved(checkout('/srv/other/orca'))
    await expect(decide(project, '/srv/mine/orca')).rejects.toThrow('already an Orca project')
  })

  it('does not reuse a clone that was killed before it finished', async () => {
    const identity = {
      canonicalKey: 'github.com/stablyai/orca',
      remoteName: 'origin',
      remoteUrl: url
    }
    const path = checkout(url, { finished: false })
    await expect(decide(saved(path))).rejects.toThrow('already an Orca project')
    // Same repo by its saved identity: let git clone, which refuses the non-empty folder.
    await expect(decide(saved(path, { gitRemoteIdentity: identity }))).resolves.toBeNull()
  })

  it('does not reuse a clone whose origin also lists another URL', async () => {
    const path = checkout('https://github.com/me/orca.git')
    git(path, 'remote', 'set-url', '--add', 'origin', url)
    await expect(decide(saved(path))).rejects.toThrow('already an Orca project')
  })

  it('refuses to re-clone into a fork project whose stored identity is its upstream', async () => {
    const path = join(tmpdir(), 'orca-saved-clone-target-deleted-fork')
    const upstream = {
      canonicalKey: 'github.com/stablyai/orca',
      remoteName: 'upstream',
      remoteUrl: url
    }
    await expect(decide(saved(path, { gitRemoteIdentity: upstream }))).rejects.toThrow(
      'already an Orca project'
    )
  })

  it('does not reuse a folder that only sits inside a clone of the URL', async () => {
    const nested = join(checkout(url), 'orca')
    mkdirSync(nested)
    await expect(decide(saved(nested))).rejects.toThrow('already an Orca project')
  })
})
