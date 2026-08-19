import { beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARINE_CREATURES } from '../shared/marine-creatures'
import type { GlobalSettings } from '../shared/global-settings-types'
import type { Repo } from '../shared/repo-types'
import {
  collectRetiredNamesFromLeafNames,
  discoverRetiredWorktreeNames,
  ensureRetiredWorktreeNamesBackfilled,
  extractBucketLeafCandidates,
  getRetiredNameRegistryForRepo,
  normalizeRetirableGeneratedName,
  resetRetirementCollisionKeyCacheForTests
} from './worktree-name-retirement'

const FIRST = MARINE_CREATURES[0].toLowerCase()
const SECOND = MARINE_CREATURES[1].toLowerCase()

const makeRepo = (id: string, path: string): Repo =>
  ({ id, path, displayName: id, badgeColor: '', addedAt: 0 }) as Repo

beforeEach(() => {
  resetRetirementCollisionKeyCacheForTests()
})

describe('normalizeRetirableGeneratedName', () => {
  it('accepts pool names and every numbered tier, not just single digits', () => {
    expect(normalizeRetirableGeneratedName(` ${FIRST} `)).toBe(FIRST)
    expect(normalizeRetirableGeneratedName(`${FIRST}-2`)).toBe(`${FIRST}-2`)
    // Why: the previous `-([2-9]\d*)` never matched these, so a path whose agent history was
    // still on disk got reissued — the exact bug this module exists to prevent.
    expect(normalizeRetirableGeneratedName(`${FIRST}-10`)).toBe(`${FIRST}-10`)
    expect(normalizeRetirableGeneratedName(`${FIRST}-100`)).toBe(`${FIRST}-100`)
  })

  it('rejects legacy repeated suffixes that the canonical collision sequence never emits', () => {
    expect(normalizeRetirableGeneratedName(`${FIRST}-2-3`)).toBeNull()
    expect(normalizeRetirableGeneratedName(`${FIRST}-2-3-4`)).toBeNull()
    expect(normalizeRetirableGeneratedName('fix-login-2-3')).toBeNull()
  })

  it('rejects names outside the pool and absurdly long input', () => {
    expect(normalizeRetirableGeneratedName('fix-login')).toBeNull()
    expect(normalizeRetirableGeneratedName('')).toBeNull()
    expect(normalizeRetirableGeneratedName(`${FIRST}-${'9'.repeat(300)}`)).toBeNull()
  })
})

describe('extractBucketLeafCandidates', () => {
  it('takes everything past the encoded parent as the leaf', () => {
    expect(extractBucketLeafCandidates(`-w-orca-${FIRST}`, ['-w-orca'])).toEqual([FIRST])
  })

  it('does not treat the parent directory as a leaf when the workspace name is numeric', () => {
    // Real data: `-Users-x-orca-workspaces-orca-7474` must not retire `orca`, which is in the pool.
    expect(extractBucketLeafCandidates('-w-workspaces-orca-7474', ['-w-workspaces-orca'])).toEqual([
      '7474'
    ])
  })

  it('offers the first segment too, so an agent run in a subdirectory still retires the leaf', () => {
    expect(extractBucketLeafCandidates(`-w-orca-${FIRST}-packages-api`, ['-w-orca'])).toEqual([
      `${FIRST}-packages-api`,
      FIRST
    ])
  })

  it('rejects a sibling directory that shares the parent prefix', () => {
    expect(extractBucketLeafCandidates(`-w-orcadyne-${FIRST}`, ['-w-orca'])).toEqual([])
    expect(extractBucketLeafCandidates(`-w-orca-secret-${FIRST}`, ['-w-orca-fix'])).toEqual([])
  })

  it('yields nothing for the parent bucket itself', () => {
    expect(extractBucketLeafCandidates('-w-orca', ['-w-orca'])).toEqual([])
  })
})

describe('collectRetiredNamesFromLeafNames', () => {
  it('keeps pool names and drops everything else', () => {
    expect(collectRetiredNamesFromLeafNames([FIRST, SECOND, 'fix-login'])).toEqual(
      new Set([FIRST, SECOND])
    )
  })

  it('is case-insensitive and skips non-string entries without throwing', () => {
    const leaves = [undefined, null, '', MARINE_CREATURES[0].toUpperCase()] as unknown as string[]
    expect(collectRetiredNamesFromLeafNames(leaves)).toEqual(new Set([FIRST]))
  })
})

describe('discoverRetiredWorktreeNames', () => {
  /** Buckets are written with the REAL per-character encoding, because a helper that mirrors the
   *  implementation would pass against a broken encoder — which is how the Windows gap shipped. */
  async function withFakeHome(
    buckets: readonly string[],
    run: (home: string) => Promise<void>
  ): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), 'orca-retirement-home-'))
    try {
      for (const bucket of buckets) {
        await mkdir(join(home, '.claude', 'projects', bucket), { recursive: true })
      }
      await run(home)
    } finally {
      await rm(home, { force: true, recursive: true })
    }
  }

  it('matches a plain POSIX workspace root', async () => {
    await withFakeHome([`-Users-ada-orca-workspaces-orca-${FIRST}`], async (home) => {
      const retired = await discoverRetiredWorktreeNames({
        workspaceRoots: ['/Users/ada/orca/workspaces/orca'],
        home,
        env: {}
      })
      expect(retired).toEqual(new Set([FIRST]))
    })
  })

  it('matches an NFC bucket for an NFD workspace root', async () => {
    const nfdRoot = '/Users/ada/cafe\u0301'
    await withFakeHome([`-Users-ada-caf--${FIRST}`], async (home) => {
      const retired = await discoverRetiredWorktreeNames({
        workspaceRoots: [nfdRoot],
        home,
        env: {}
      })
      expect(retired).toEqual(new Set([FIRST]))
    })
  })

  it('matches a dot-directory root, where the separator run encodes to two dashes', async () => {
    await withFakeHome([`-Users-ada--orca-worktrees-${FIRST}`], async (home) => {
      const retired = await discoverRetiredWorktreeNames({
        workspaceRoots: ['/Users/ada/.orca/worktrees'],
        home,
        env: {}
      })
      expect(retired).toEqual(new Set([FIRST]))
    })
  })

  it('matches a Windows drive root', async () => {
    // `getDefaultWorkspaceDir` returns `C:\Users\<user>\orca\workspaces` on Windows, so an encoder
    // that collapsed `:\` rejected every bucket on that platform by default.
    await withFakeHome([`C--Users-ada-orca-workspaces-${FIRST}`], async (home) => {
      const retired = await discoverRetiredWorktreeNames({
        workspaceRoots: ['C:\\Users\\ada\\orca\\workspaces'],
        home,
        env: {}
      })
      expect(retired).toEqual(new Set([FIRST]))
    })
  })

  it('matches a WSL UNC root', async () => {
    await withFakeHome([`--wsl--Ubuntu-home-ada-orca-workspaces-${FIRST}`], async (home) => {
      const retired = await discoverRetiredWorktreeNames({
        workspaceRoots: ['\\\\wsl$\\Ubuntu\\home\\ada\\orca\\workspaces'],
        home,
        env: {}
      })
      expect(retired).toEqual(new Set([FIRST]))
    })
  })

  it('ignores buckets belonging to a sibling root with the same prefix', async () => {
    await withFakeHome(
      [`-Users-ada-orca-workspaces-orcadyne-${FIRST}`, `-Users-ada-orca-workspaces-orca-${SECOND}`],
      async (home) => {
        const retired = await discoverRetiredWorktreeNames({
          workspaceRoots: ['/Users/ada/orca/workspaces/orca'],
          home,
          env: {}
        })
        expect(retired).toEqual(new Set([SECOND]))
      }
    )
  })

  it('reads buckets from CLAUDE_CONFIG_DIR when it is set', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'orca-retirement-config-'))
    await withFakeHome([`-Users-ada-w-${SECOND}`], async (home) => {
      try {
        await mkdir(join(configDir, 'projects', `-Users-ada-w-${FIRST}`), { recursive: true })
        const retired = await discoverRetiredWorktreeNames({
          workspaceRoots: ['/Users/ada/w'],
          home,
          env: { CLAUDE_CONFIG_DIR: configDir }
        })
        // The override relocates the whole state root, so the default home is not also scanned.
        expect(retired).toEqual(new Set([FIRST]))
      } finally {
        await rm(configDir, { force: true, recursive: true })
      }
    })
  })

  it('retires live workspace directories alongside surviving buckets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-retirement-roots-'))
    await withFakeHome([], async (home) => {
      try {
        await mkdir(join(root, SECOND), { recursive: true })
        const retired = await discoverRetiredWorktreeNames({
          workspaceRoots: [root],
          home,
          env: {}
        })
        expect(retired).toEqual(new Set([SECOND]))
      } finally {
        await rm(root, { force: true, recursive: true })
      }
    })
  })
})

describe('getRetiredNameRegistryForRepo', () => {
  const settingsFor = (nestWorkspaces: boolean): GlobalSettings =>
    ({ workspaceDir: '/workspaces', nestWorkspaces }) as GlobalSettings
  const storeOf = (byRepo: Record<string, string[]>) => {
    const calls: string[] = []
    return {
      calls,
      mergeRetiredWorktreeNames: () => false,
      getRetiredWorktreeNameRegistry: (repoId: string) => {
        calls.push(repoId)
        return { exhaustedTiers: 0, names: byRepo[repoId] ?? [] }
      }
    }
  }

  it('shares retirements when two repos create into the same cwd namespace', async () => {
    const store = storeOf({ 'repo-a': [FIRST], 'repo-b': [SECOND] })
    const repos = [makeRepo('repo-a', '/repos/a'), makeRepo('repo-b', '/repos/b')]

    expect(
      [
        ...(await getRetiredNameRegistryForRepo(store, repos[1], repos, settingsFor(false))).names
      ].sort()
    ).toEqual([FIRST, SECOND].sort())
  })

  it('keeps independent nested repo paths in separate retirement domains', async () => {
    const store = storeOf({ 'repo-a': [FIRST], 'repo-b': [SECOND] })
    const repos = [makeRepo('repo-a', '/repos/a'), makeRepo('repo-b', '/repos/b')]

    expect(await getRetiredNameRegistryForRepo(store, repos[1], repos, settingsFor(true))).toEqual({
      exhaustedTiers: 0,
      names: [SECOND]
    })
  })

  it('never probes a path for peers that hold no retirements', async () => {
    const pathReads: string[] = []
    const spyRepo = (id: string, path: string): Repo => {
      const repo = makeRepo(id, path)
      return Object.defineProperty(repo, 'path', {
        get: () => {
          pathReads.push(id)
          return path
        }
      }) as Repo
    }
    const store = storeOf({ 'repo-a': [FIRST] })
    const repos = [
      spyRepo('repo-a', '/repos/a'),
      ...Array.from({ length: 20 }, (_unused, index) => spyRepo(`peer-${index}`, `/repos/${index}`))
    ]

    expect(await getRetiredNameRegistryForRepo(store, repos[0], repos, settingsFor(false))).toEqual(
      {
        exhaustedTiers: 0,
        names: [FIRST]
      }
    )
    expect(pathReads.filter((id) => id.startsWith('peer-'))).toEqual([])
  })

  it('reports nothing for a folder workspace, which has no generated worktree names', async () => {
    const store = storeOf({ folder: [FIRST] })
    const folderRepo = { ...makeRepo('folder', '/repos/folder'), kind: 'folder' as const }

    expect(
      (await getRetiredNameRegistryForRepo(store, folderRepo, [folderRepo], settingsFor(false)))
        .names
    ).toEqual([])
  })
})

describe('ensureRetiredWorktreeNamesBackfilled', () => {
  it('awaits the historical workspace scan before returning names to a client', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-retirement-backfill-'))
    const workspaceRoot = join(root, 'workspaces')
    await mkdir(join(workspaceRoot, FIRST), { recursive: true })
    const merged: { repoId: string; names: string[] }[] = []
    const store = {
      mergeRetiredWorktreeNames: (repoId: string, names: Iterable<string>) => {
        merged.push({ repoId, names: [...names] })
        return true
      }
    }
    const settings = { workspaceDir: workspaceRoot, nestWorkspaces: false }

    try {
      await ensureRetiredWorktreeNamesBackfilled(store, makeRepo('repo-a', '/repos/a'), settings)
      expect(merged).toEqual([{ repoId: 'repo-a', names: [FIRST] }])

      // Why: the scan is cached per cwd namespace but the registry is per repo, so a second repo in
      // the same namespace must still receive the merge rather than silently inheriting nothing.
      await ensureRetiredWorktreeNamesBackfilled(store, makeRepo('repo-b', '/repos/b'), settings)
      expect(merged).toEqual([
        { repoId: 'repo-a', names: [FIRST] },
        { repoId: 'repo-b', names: [FIRST] }
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('skips repos whose agent state lives on another host', async () => {
    const merged: string[] = []
    const store = {
      mergeRetiredWorktreeNames: (_repoId: string, names: Iterable<string>) => {
        merged.push(...names)
        return true
      }
    }
    const sshRepo = { ...makeRepo('repo-ssh', '/remote/repo'), connectionId: 'ssh-1' }

    await ensureRetiredWorktreeNamesBackfilled(store, sshRepo, {
      workspaceDir: '/workspaces',
      nestWorkspaces: false
    })

    expect(merged).toEqual([])
  })

  it('skips a runtime-owned repo, which has no connectionId but is still not local', async () => {
    // Why: a `connectionId` check calls this repo local, so the scan reads THIS machine's
    // directories and files them under the runtime's namespace — retiring names never used there
    // while missing the ones that were. The host id is the only reliable local test.
    const root = await mkdtemp(join(tmpdir(), 'orca-retirement-runtime-'))
    const workspaceRoot = join(root, 'workspaces')
    await mkdir(join(workspaceRoot, FIRST), { recursive: true })
    const merged: string[] = []
    const store = {
      mergeRetiredWorktreeNames: (_repoId: string, names: Iterable<string>) => {
        merged.push(...names)
        return true
      }
    }
    const runtimeRepo = {
      ...makeRepo('repo-runtime', '/repos/runtime'),
      executionHostId: 'runtime:env-1'
    } as Repo

    try {
      const collisionKey = await ensureRetiredWorktreeNamesBackfilled(store, runtimeRepo, {
        workspaceDir: workspaceRoot,
        nestWorkspaces: false
      })

      expect(merged).toEqual([])
      expect(collisionKey).toBeNull()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('still backfills a plain local repo, so the skip is scoped to non-local hosts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-retirement-local-'))
    const workspaceRoot = join(root, 'workspaces')
    await mkdir(join(workspaceRoot, FIRST), { recursive: true })
    const merged: string[] = []
    const store = {
      mergeRetiredWorktreeNames: (_repoId: string, names: Iterable<string>) => {
        merged.push(...names)
        return true
      }
    }

    try {
      await ensureRetiredWorktreeNamesBackfilled(store, makeRepo('repo-local', '/repos/local'), {
        workspaceDir: workspaceRoot,
        nestWorkspaces: false
      })

      expect(merged).toEqual([FIRST])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
