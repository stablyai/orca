import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveNestedPrRepositoryFallback,
  resolveSdlcOrNestedIssueRepository
} from './sdlc-issue-repository'
import type { GitHubApiRepository } from './github-api-repository'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-sdlc-repo-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

describe('sdlc-issue-repository', () => {
  it('resolves .w0m/sdlc.json vcs.repo for estate repositories', async () => {
    const root = await createTempDir()
    await mkdir(join(root, '.w0m'), { recursive: true })
    await writeFile(
      join(root, '.w0m', 'sdlc.json'),
      JSON.stringify({
        canonical_repo: 'w0m-web',
        vcs: {
          provider: 'github',
          repo: 'webomage/wom7board'
        }
      })
    )

    const resolved = await resolveSdlcOrNestedIssueRepository({
      repoPath: root,
      origin: { owner: 'webomage', repo: 'w0m', host: 'github.com' },
      probeRemote: async () => null
    })

    expect(resolved).toEqual({
      owner: 'webomage',
      repo: 'wom7board',
      host: 'github.com'
    })
  })

  it('resolves nested canonical_repo git remote for -w0m governance wrapper workspaces', async () => {
    const root = await createTempDir()
    await mkdir(join(root, '.w0m'), { recursive: true })
    await mkdir(join(root, 'bridgeroad-app', '.git'), { recursive: true })
    await writeFile(
      join(root, '.w0m', 'sdlc.json'),
      JSON.stringify({
        canonical_repo: 'bridgeroad-app',
        vcs: {
          provider: 'github',
          repo: 'BridgeRoad/bridgeroad-app'
        }
      })
    )

    const remoteMap = new Map<string, GitHubApiRepository>([
      [
        `${join(root, 'bridgeroad-app')}:origin`,
        { owner: 'Bridgeroad-app', repo: 'bridgeroad-app', host: 'github.com' }
      ]
    ])

    const issueRepo = await resolveSdlcOrNestedIssueRepository({
      repoPath: root,
      origin: { owner: 'casualuser', repo: 'bridgeroad-w0m', host: 'github.com' },
      probeRemote: async (targetPath, remoteName) =>
        remoteMap.get(`${targetPath}:${remoteName}`) ?? null
    })

    const prFallback = await resolveNestedPrRepositoryFallback({
      repoPath: root,
      origin: { owner: 'casualuser', repo: 'bridgeroad-w0m', host: 'github.com' },
      probeRemote: async (targetPath, remoteName) =>
        remoteMap.get(`${targetPath}:${remoteName}`) ?? null
    })

    expect(issueRepo).toEqual({
      owner: 'Bridgeroad-app',
      repo: 'bridgeroad-app',
      host: 'github.com'
    })
    expect(prFallback.originCandidate).toEqual({
      owner: 'Bridgeroad-app',
      repo: 'bridgeroad-app',
      host: 'github.com'
    })
  })

  it('falls back to direct child subfolder git repo when umbrella folder has no origin remote', async () => {
    const root = await createTempDir()
    await mkdir(join(root, 'nested-app', '.git'), { recursive: true })

    const issueRepo = await resolveSdlcOrNestedIssueRepository({
      repoPath: root,
      origin: null,
      probeRemote: async (targetPath, remoteName) =>
        targetPath === join(root, 'nested-app') && remoteName === 'origin'
          ? { owner: 'acme', repo: 'nested-app', host: 'github.com' }
          : null
    })

    expect(issueRepo).toEqual({
      owner: 'acme',
      repo: 'nested-app',
      host: 'github.com'
    })
  })
})
