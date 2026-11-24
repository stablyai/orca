import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { ProcessResult } from '@orca/process-host/process-spec'
import { makeRepo } from '../../persistence/persistence-test-harness'
import { listWorktreesStrict } from '../../git/worktrees/catalog/worktree-listing'
import { readWorktreeProviderCatalog } from './provider-config-reader'
import { acquireProviderWorktree } from './provider-acquire'
import { releaseProviderWorktree } from './provider-release'
import type { WorktreeProviderCommandPhase } from './provider-process-runner'

type Call = { phase: WorktreeProviderCommandPhase; argv: readonly string[] }

const BASE_META = {
  displayName: '',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
} satisfies Partial<WorktreeMeta>

function result(code: number, stdout = '', stderr = ''): ProcessResult {
  return { code, signal: null, stdout, stderr, timedOut: false }
}

describe('provider-managed acquire and release', () => {
  let dir = ''
  let repoPath = ''
  let slot = ''
  let repo = makeRepo()
  let meta: Map<string, WorktreeMeta>
  let calls: Call[]
  let releaseCode = 0
  let claimStdout = ''
  let claimTimedOut = false

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-provider-lifecycle-'))
    repoPath = join(dir, 'repo')
    slot = join(dir, 'slot')
    execFileSync('git', ['init', '-q', repoPath])
    execFileSync('git', ['-C', repoPath, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', repoPath, 'config', 'user.name', 'Test'])
    writeFileSync(join(repoPath, 'README.md'), 'hello\n')
    execFileSync('git', ['-C', repoPath, 'add', '.'])
    execFileSync('git', ['-C', repoPath, 'commit', '-qm', 'init'])
    execFileSync('git', ['-C', repoPath, 'worktree', 'add', '-q', '-b', 'slot', slot])
    repo = makeRepo({ id: 'repo-1', path: repoPath, connectionId: undefined })
    meta = new Map()
    calls = []
    releaseCode = 0
    claimTimedOut = false
    claimStdout = JSON.stringify({
      path: slot,
      lease_id: 'lease-1',
      profile: 'cone',
      handle: { token: 'abc' }
    })
    writeFileSync(
      join(dir, 'providers.yaml'),
      'providers:\n  stub:\n    claim: ["pool", "claim"]\n    release: ["pool", "release"]\n'
    )
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function catalog(repoOrcaYamlPath = join(dir, 'missing-orca.yaml')) {
    return await readWorktreeProviderCatalog({
      repo,
      trust: { repos: {} },
      userConfigPath: join(dir, 'providers.yaml'),
      repoOrcaYamlPath
    })
  }

  function ports() {
    return {
      getMeta: (worktreeId: string) => meta.get(worktreeId),
      setMeta: (worktreeId: string, update: Partial<WorktreeMeta>) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake store only reads fields written through this helper, and the base fixture supplies the required ones.
        meta.set(worktreeId, { ...BASE_META, ...meta.get(worktreeId), ...update } as WorktreeMeta)
      },
      listWorktrees: (path: string) => listWorktreesStrict(path),
      invalidateScan: () => {},
      notifyChanged: () => {},
      showWorktree: async (selector: string): Promise<Worktree> => {
        const worktreeId = selector.replace(/^id:/, '')
        const stored = meta.get(worktreeId)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test only reads the fields the acquire path writes.
        return {
          id: worktreeId,
          repoId: repo.id,
          path: slot,
          branch: 'refs/heads/slot',
          displayName: stored?.displayName ?? 'slot',
          worktreeProvider: stored?.worktreeProvider,
          providerManaged: stored?.worktreeProvider ? true : undefined
        } as Worktree
      },
      hasWslDistro: () => false,
      runCommand: async (args: {
        phase: WorktreeProviderCommandPhase
        argv: readonly string[]
      }): Promise<ProcessResult> => {
        calls.push({ phase: args.phase, argv: args.argv })
        if (args.phase === 'claim') {
          return { ...result(0, claimStdout), timedOut: claimTimedOut }
        }
        if (args.phase === 'release') {
          return releaseCode === 0 ? result(0) : result(releaseCode, '', 'slot is dirty')
        }
        return result(0)
      },
      now: () => 1000
    }
  }

  function releasePorts() {
    return {
      teardown: async () => ({}),
      purge: async (worktreeId: string) => {
        meta.delete(worktreeId)
      },
      invalidateScan: () => {},
      notifyChanged: () => {},
      runCommand: ports().runCommand
    }
  }

  async function acquire() {
    return await acquireProviderWorktree({
      repo,
      providerName: 'stub',
      profile: 'cone',
      catalog: await catalog(),
      ports: ports()
    })
  }

  it('registers a claimed slot and releases it through the provider', async () => {
    const acquired = await acquire()
    expect(acquired.claim).toEqual({
      name: 'stub',
      profile: 'cone',
      leaseId: 'lease-1',
      handle: { token: 'abc' },
      timeoutSeconds: 300,
      acquiredAt: 1000,
      configHash: expect.any(String)
    })
    expect(calls[0].argv).toEqual(['pool', 'claim', '--repo', repoPath, '--profile', 'cone'])
    const worktreeId = `${repo.id}::${slot}`
    expect(meta.get(worktreeId)?.worktreeProvider?.leaseId).toBe('lease-1')

    const released = await releaseProviderWorktree({
      repo,
      worktreeId,
      worktreePath: slot,
      meta: meta.get(worktreeId)!,
      catalog: await catalog(),
      force: false,
      forget: false,
      ports: releasePorts()
    })
    expect(released.released).toBe(true)
    expect(calls.at(-1)?.argv).toEqual([
      'pool',
      'release',
      slot,
      '--repo',
      repoPath,
      '--lease-id',
      'lease-1',
      '--handle',
      '{"token":"abc"}'
    ])
    expect(meta.has(worktreeId)).toBe(false)
  })

  it('keeps the workspace when the provider refuses a dirty release', async () => {
    await acquire()
    const worktreeId = `${repo.id}::${slot}`
    releaseCode = 75
    await expect(
      releaseProviderWorktree({
        repo,
        worktreeId,
        worktreePath: slot,
        meta: meta.get(worktreeId)!,
        catalog: await catalog(),
        force: false,
        forget: false,
        ports: releasePorts()
      })
    ).rejects.toMatchObject({
      code: 'worktree_provider_release_refused',
      message: expect.stringContaining('slot is dirty')
    })
    expect(meta.has(worktreeId)).toBe(true)
  })

  it('forgets a workspace without calling the provider', async () => {
    await acquire()
    const worktreeId = `${repo.id}::${slot}`
    const before = calls.length
    const released = await releaseProviderWorktree({
      repo,
      worktreeId,
      worktreePath: slot,
      meta: meta.get(worktreeId)!,
      catalog: await catalog(),
      force: false,
      forget: true,
      ports: releasePorts()
    })
    expect(released.forgotten).toBe(true)
    expect(calls.length).toBe(before)
    expect(meta.has(worktreeId)).toBe(false)
  })

  it('releases a lease when the claim path is malformed, so the slot is not orphaned', async () => {
    claimStdout = JSON.stringify({ lease_id: 'lease-orphan' })
    await expect(acquire()).rejects.toMatchObject({ code: 'worktree_provider_claim_invalid' })
    expect(calls.some((call) => call.phase === 'release')).toBe(true)
    expect(calls.find((call) => call.phase === 'release')?.argv).toContain('lease-orphan')
  })

  it('releases a lease printed before a claim timeout', async () => {
    claimTimedOut = true
    claimStdout = JSON.stringify({ lease_id: 'lease-timeout' })
    await expect(acquire()).rejects.toMatchObject({ code: 'worktree_provider_claim_timeout' })
    expect(calls.some((call) => call.phase === 'release')).toBe(true)
    expect(calls.find((call) => call.phase === 'release')?.argv).toContain('lease-timeout')
  })

  it('releases a claim when the path already has an Orca workspace', async () => {
    const worktreeId = `${repo.id}::${slot}`
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake store accepts the partial fixture the test reads back.
    meta.set(worktreeId, { ...BASE_META, displayName: 'existing' } as WorktreeMeta)
    await expect(acquire()).rejects.toMatchObject({ code: 'worktree_provider_path_conflict' })
    expect(calls.some((call) => call.phase === 'release')).toBe(true)
  })

  it('does not execute an untrusted repo provider', async () => {
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      'providers:\n  repoprov:\n    claim: ["pool", "claim"]\n    release: ["pool", "release"]\n'
    )
    await expect(
      acquireProviderWorktree({
        repo,
        providerName: 'repoprov',
        catalog: await catalog(join(repoPath, 'orca.yaml')),
        ports: ports()
      })
    ).rejects.toMatchObject({ code: 'worktree_provider_untrusted' })
    expect(calls).toEqual([])
  })

  it('refuses a remote repository before running a command', async () => {
    repo = makeRepo({
      id: 'repo-1',
      path: repoPath,
      connectionId: 'ssh:box',
      executionHostId: 'ssh:box'
    })
    await expect(
      acquireProviderWorktree({
        repo,
        providerName: 'stub',
        catalog: await catalog(),
        ports: ports()
      })
    ).rejects.toMatchObject({ code: 'worktree_provider_not_local' })
    expect(calls).toEqual([])
  })

  it('does not treat a non-provider workspace as releasable', async () => {
    const worktreeId = `${repo.id}::${slot}`
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake store accepts the partial fixture the test reads back.
    meta.set(worktreeId, { ...BASE_META, displayName: 'ordinary' } as WorktreeMeta)
    await expect(
      releaseProviderWorktree({
        repo,
        worktreeId,
        worktreePath: slot,
        meta: meta.get(worktreeId)!,
        catalog: await catalog(),
        force: false,
        forget: false,
        ports: releasePorts()
      })
    ).rejects.toMatchObject({ code: 'worktree_provider_not_managed' })
  })
})
