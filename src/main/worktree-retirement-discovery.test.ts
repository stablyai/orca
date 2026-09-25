import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARINE_CREATURES } from '../shared/marine-creatures'
import {
  collectRetiredNamesFromLeafNames,
  discoverRetiredWorktreeNames,
  extractBucketLeafCandidates
} from './worktree-retirement-discovery'

const FIRST = MARINE_CREATURES[0].toLowerCase()
const SECOND = MARINE_CREATURES[1].toLowerCase()

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

  it('calls a machine with no agent state a complete answer, not a hole to rescan forever', async () => {
    // ENOENT is the common case — a Codex-only or fresh install has no `~/.claude/projects`, and
    // no workspace root until the first create. Reporting that as incomplete would turn the
    // one-time seed into a rescan on every composer open for the life of the process.
    const retired = await discoverRetiredWorktreeNames({
      workspaceRoots: [join(tmpdir(), 'orca-retirement-absent-root')],
      home: join(tmpdir(), 'orca-retirement-absent-home'),
      env: {}
    })

    expect(retired.names).toEqual(new Set())
    expect(retired.complete).toBe(true)
  })

  it('matches a plain POSIX workspace root', async () => {
    await withFakeHome([`-Users-ada-orca-workspaces-orca-${FIRST}`], async (home) => {
      const retired = await discoverRetiredWorktreeNames({
        workspaceRoots: ['/Users/ada/orca/workspaces/orca'],
        home,
        env: {}
      })
      expect(retired.names).toEqual(new Set([FIRST]))
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
      expect(retired.names).toEqual(new Set([FIRST]))
    })
  })

  it('matches a dot-directory root, where the separator run encodes to two dashes', async () => {
    await withFakeHome([`-Users-ada--orca-worktrees-${FIRST}`], async (home) => {
      const retired = await discoverRetiredWorktreeNames({
        workspaceRoots: ['/Users/ada/.orca/worktrees'],
        home,
        env: {}
      })
      expect(retired.names).toEqual(new Set([FIRST]))
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
      expect(retired.names).toEqual(new Set([FIRST]))
    })
  })

  it('matches a WSL UNC root', async () => {
    await withFakeHome([`--wsl--Ubuntu-home-ada-orca-workspaces-${FIRST}`], async (home) => {
      const retired = await discoverRetiredWorktreeNames({
        workspaceRoots: ['\\\\wsl$\\Ubuntu\\home\\ada\\orca\\workspaces'],
        home,
        env: {},
        // Stubbed even though this case asserts the host-side bucket: the real resolver shells out
        // to `wsl.exe`, so on a Windows runner this unit test would boot the developer's distro.
        resolveWslHome: async () => null
      })
      expect(retired.names).toEqual(new Set([FIRST]))
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
        expect(retired.names).toEqual(new Set([SECOND]))
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
        expect(retired.names).toEqual(new Set([FIRST]))
      } finally {
        await rm(configDir, { force: true, recursive: true })
      }
    })
  })

  it("matches a WSL workspace's bucket inside the distro, keyed by its Linux cwd", async () => {
    // The agent for a WSL workspace is spawned through `wsl.exe`, so it runs inside the distro:
    // its cwd is `/home/ada/...`, and its bucket lands in the distro's own home — not the
    // Windows-side one. After the workspace directory is gone, that bucket is the only evidence.
    const distroHome = await mkdtemp(join(tmpdir(), 'orca-retirement-distro-'))
    await withFakeHome([], async (home) => {
      try {
        await mkdir(join(distroHome, '.claude', 'projects', `-home-ada-orca-workspaces-${FIRST}`), {
          recursive: true
        })
        const retired = await discoverRetiredWorktreeNames({
          workspaceRoots: ['\\\\wsl.localhost\\Ubuntu\\home\\ada\\orca\\workspaces'],
          home,
          env: {},
          resolveWslHome: async (distro) => (distro === 'Ubuntu' ? distroHome : null)
        })
        expect(retired.names).toEqual(new Set([FIRST]))
      } finally {
        await rm(distroHome, { force: true, recursive: true })
      }
    })
  })

  it('still reads the Windows-side home for a WSL root when the distro home cannot be resolved', async () => {
    // A stopped distro must not cost the retirements the host can still see.
    await withFakeHome(
      [`--wsl-localhost-Ubuntu-home-ada-orca-workspaces-${FIRST}`],
      async (home) => {
        const retired = await discoverRetiredWorktreeNames({
          workspaceRoots: ['\\\\wsl.localhost\\Ubuntu\\home\\ada\\orca\\workspaces'],
          home,
          env: {},
          resolveWslHome: async () => null
        })
        expect(retired.names).toEqual(new Set([FIRST]))
      }
    )
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
        expect(retired.names).toEqual(new Set([SECOND]))
      } finally {
        await rm(root, { force: true, recursive: true })
      }
    })
  })
})
