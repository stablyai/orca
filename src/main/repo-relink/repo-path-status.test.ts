import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Repo } from '../../shared/repo-types'
import type { IFilesystemProvider } from '../providers/types'
import {
  createSshRepoHostFilesystem,
  localRepoHostFilesystem,
  type RepoHostFilesystem
} from './repo-host-filesystem'
import { inspectRepoPathStatus, RepoPathStatusCollector } from './repo-path-status'

let root = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-repo-path-status-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function checkout(name: string): string {
  const path = join(root, name)
  mkdirSync(join(path, '.git'), { recursive: true })
  return path
}

function repo(overrides: Partial<Repo>): Repo {
  return { id: 'r', path: '/x', displayName: 'x', badgeColor: '#000000', addedAt: 0, ...overrides }
}

describe('inspectRepoPathStatus on the local host', () => {
  it('reports a checkout as present', async () => {
    expect(await inspectRepoPathStatus(checkout('app'), localRepoHostFilesystem)).toEqual({
      state: 'present'
    })
  })

  it('reports a missing folder, a file, and a folder without .git as missing', async () => {
    writeFileSync(join(root, 'file'), '')
    mkdirSync(join(root, 'plain'))
    expect(await inspectRepoPathStatus(join(root, 'gone'), localRepoHostFilesystem)).toEqual({
      state: 'missing',
      reason: 'not-found'
    })
    expect(await inspectRepoPathStatus(join(root, 'file'), localRepoHostFilesystem)).toEqual({
      state: 'missing',
      reason: 'not-directory'
    })
    expect(await inspectRepoPathStatus(join(root, 'plain'), localRepoHostFilesystem)).toEqual({
      state: 'missing',
      reason: 'not-git-root'
    })
  })

  it.skipIf(process.platform === 'win32')(
    'offers the target when the old path is now a symlink to a checkout',
    async () => {
      const target = checkout('moved/app')
      const oldPath = join(root, 'app')
      symlinkSync(target, oldPath)
      expect(await inspectRepoPathStatus(oldPath, localRepoHostFilesystem)).toEqual({
        state: 'moved',
        target
      })
      const dangling = join(root, 'dangling')
      symlinkSync(join(root, 'nowhere'), dangling)
      expect(await inspectRepoPathStatus(dangling, localRepoHostFilesystem)).toEqual({
        state: 'missing',
        reason: 'not-found'
      })
    }
  )
})

describe('inspectRepoPathStatus on an SSH host', () => {
  function sshFs(stat: (path: string) => Promise<{ type: 'directory' | 'file' }>) {
    const provider = {
      stat: vi.fn(async (path: string) => ({ size: 0, mtime: 0, ...(await stat(path)) })),
      realpath: vi.fn(async (path: string) => path)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: detection only calls stat/lstat/realpath, all stubbed.
    return createSshRepoHostFilesystem(provider as unknown as IFilesystemProvider)
  }

  it('treats a relayed ENOENT as missing', async () => {
    const fs = sshFs(async (path) => {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
    })
    expect(await inspectRepoPathStatus('/home/me/app', fs)).toEqual({
      state: 'missing',
      reason: 'not-found'
    })
  })

  it('falls back to stat when an old relay has no lstat', async () => {
    const provider = {
      lstat: vi.fn(async () => {
        throw new Error('remote_lstat_unavailable')
      }),
      stat: vi.fn(async () => ({ size: 0, mtime: 0, type: 'directory' as const })),
      realpath: vi.fn(async (path: string) => path)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: detection only calls stat/lstat/realpath, all stubbed.
    const fs = createSshRepoHostFilesystem(provider as unknown as IFilesystemProvider)
    expect(await inspectRepoPathStatus('/home/me/app', fs)).toEqual({ state: 'present' })
  })

  it('never reports lost contact as missing', async () => {
    const fs = sshFs(async () => {
      throw Object.assign(new Error('SSH connection lost, reconnecting...'), {
        code: 'CONNECTION_LOST'
      })
    })
    expect(await inspectRepoPathStatus('/home/me/app', fs)).toEqual({ state: 'unverifiable' })
    expect(await inspectRepoPathStatus('/home/me/app', null)).toEqual({ state: 'unverifiable' })
  })
})

describe('RepoPathStatusCollector', () => {
  it('checks git repos on reachable hosts, skips runtime hosts and folder projects, and caches', async () => {
    const inspectEntry = vi.fn(async () => 'directory' as const)
    const fs: RepoHostFilesystem = {
      inspectEntry,
      inspectTarget: async () => 'directory',
      resolveRealPath: async (path) => path,
      join: (base, segment) => `${base}/${segment}`
    }
    let now = 1_000
    const collector = new RepoPathStatusCollector(
      () => fs,
      () => now
    )
    const repos = [
      repo({ id: 'local', path: '/a' }),
      repo({ id: 'ssh', path: '/b', connectionId: 'box', executionHostId: 'ssh:box' }),
      repo({ id: 'runtime', path: '/c', executionHostId: 'runtime:env' }),
      repo({ id: 'folder', path: '/d', kind: 'folder' })
    ]
    const first = await collector.collect(repos)
    expect(first.map((entry) => [entry.repoId, entry.hostId, entry.status.state])).toEqual([
      ['local', 'local', 'present'],
      ['ssh', 'ssh:box', 'present']
    ])
    const calls = inspectEntry.mock.calls.length
    await collector.collect(repos)
    expect(inspectEntry.mock.calls.length).toBe(calls)
    await collector.collect(repos, { force: true })
    expect(inspectEntry.mock.calls.length).toBeGreaterThan(calls)
    now += 60_000
    const beforeExpiry = inspectEntry.mock.calls.length
    await collector.collect(repos)
    expect(inspectEntry.mock.calls.length).toBeGreaterThan(beforeExpiry)
  })
})
