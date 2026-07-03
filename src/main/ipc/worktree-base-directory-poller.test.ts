import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  startWorktreeBaseDirectoryPoller,
  type WorktreeBasePollEvent
} from './worktree-base-directory-poller'
import type {
  WorktreeBaseRepoWatchConfig,
  WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'

const POLL_MS = 25

function makeTarget(
  kind: 'base' | 'git-common',
  path: string,
  config: Partial<WorktreeBaseRepoWatchConfig> = {}
): WorktreeBaseWatchTarget {
  const repoConfig: WorktreeBaseRepoWatchConfig = {
    repoId: 'repo-1',
    repoName: 'project',
    nestWorkspaces: false,
    ...config
  }
  return {
    key: `${kind}:local:${path}`,
    kind,
    path,
    repos: new Map([[repoConfig.repoId, repoConfig]])
  }
}

async function waitForEvents(
  events: WorktreeBasePollEvent[][],
  predicate: (flat: WorktreeBasePollEvent[]) => boolean
): Promise<WorktreeBasePollEvent[]> {
  await vi.waitFor(
    () => {
      if (!predicate(events.flat())) {
        throw new Error('expected poll events not observed yet')
      }
    },
    { timeout: 5_000, interval: 20 }
  )
  return events.flat()
}

describe('worktree base directory poller', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  })

  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-base-poller-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    // Why: macOS tmpdir lives behind the /var -> /private/var symlink and
    // native watcher events report resolved paths; production targets are
    // realpath'd the same way (canonicalizeExistingPath).
    return realpath(root)
  }

  it('emits a .git marker create and a worktree delete for flat layouts', async () => {
    const root = await makeRoot()
    const received: WorktreeBasePollEvent[][] = []
    const target = makeTarget('base', root)
    const poller = await startWorktreeBaseDirectoryPoller(
      target,
      () => target.repos,
      (events) => received.push(events),
      { pollIntervalMs: POLL_MS }
    )
    cleanups.push(() => poller.unsubscribe())

    const worktree = join(root, 'external-1')
    await mkdir(worktree)
    await writeFile(join(worktree, '.git'), 'gitdir: elsewhere')

    const afterCreate = await waitForEvents(received, (flat) =>
      flat.some((event) => event.type === 'create' && event.path === join(worktree, '.git'))
    )
    expect(
      afterCreate.filter((event) => event.type === 'create' && event.path.endsWith('.git'))
    ).toHaveLength(1)

    await rm(worktree, { recursive: true })
    await waitForEvents(received, (flat) =>
      flat.some((event) => event.type === 'delete' && event.path === worktree)
    )
  })

  it('emits the marker only after it appears for slow checkouts', async () => {
    const root = await makeRoot()
    const received: WorktreeBasePollEvent[][] = []
    const target = makeTarget('base', root)
    const poller = await startWorktreeBaseDirectoryPoller(
      target,
      () => target.repos,
      (events) => received.push(events),
      { pollIntervalMs: POLL_MS }
    )
    cleanups.push(() => poller.unsubscribe())

    const worktree = join(root, 'external-2')
    await mkdir(worktree)
    // Give the poller time to observe the marker-less dir first.
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3))
    expect(received.flat()).toHaveLength(0)

    await writeFile(join(worktree, '.git'), 'gitdir: elsewhere')
    await waitForEvents(received, (flat) =>
      flat.some((event) => event.type === 'create' && event.path === join(worktree, '.git'))
    )
  })

  it('scans nested repo containers for nested layouts', async () => {
    const root = await makeRoot()
    const received: WorktreeBasePollEvent[][] = []
    const target = makeTarget('base', root, { nestWorkspaces: true })
    const poller = await startWorktreeBaseDirectoryPoller(
      target,
      () => target.repos,
      (events) => received.push(events),
      { pollIntervalMs: POLL_MS }
    )
    cleanups.push(() => poller.unsubscribe())

    const worktree = join(root, 'project', 'external-3')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, '.git'), 'gitdir: elsewhere')

    await waitForEvents(received, (flat) =>
      flat.some((event) => event.type === 'create' && event.path === join(worktree, '.git'))
    )
  })

  it('skips full scans while the gate dirs are untouched', async () => {
    const root = await makeRoot()
    const worktree = join(root, 'external-idle')
    await mkdir(worktree)
    await writeFile(join(worktree, '.git'), 'gitdir: elsewhere')

    const received: WorktreeBasePollEvent[][] = []
    const fullScans: number[] = []
    const target = makeTarget('base', root)
    const poller = await startWorktreeBaseDirectoryPoller(
      target,
      () => target.repos,
      (events) => received.push(events),
      { pollIntervalMs: POLL_MS, onFullScan: () => fullScans.push(Date.now()) }
    )
    cleanups.push(() => poller.unsubscribe())

    // ~8 idle ticks: under the backstop cadence, so the gate should skip
    // every full scan (each tick is just gate-dir stats).
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 8))
    expect(fullScans).toHaveLength(0)
    expect(received.flat()).toHaveLength(0)

    // Touching the root (new entry) flips the gate and triggers a scan.
    await mkdir(join(root, 'external-new'))
    await writeFile(join(root, 'external-new', '.git'), 'gitdir: elsewhere')
    await waitForEvents(received, (flat) =>
      flat.some(
        (event) => event.type === 'create' && event.path === join(root, 'external-new', '.git')
      )
    )
    expect(fullScans.length).toBeGreaterThan(0)
  })

  it('reports git-common worktrees metadata adds, updates, and removals via polling', async () => {
    const commonDir = await makeRoot()
    const received: WorktreeBasePollEvent[][] = []
    const target = makeTarget('git-common', commonDir)
    const poller = await startWorktreeBaseDirectoryPoller(
      target,
      () => target.repos,
      (events) => received.push(events),
      // Force the non-darwin poll path so this test is deterministic on all CI.
      { pollIntervalMs: POLL_MS, platform: 'linux' }
    )
    cleanups.push(() => poller.unsubscribe())

    const entry = join(commonDir, 'worktrees', 'external-4')
    await mkdir(entry, { recursive: true })
    await waitForEvents(received, (flat) =>
      flat.some((event) => event.type === 'create' && event.path === entry)
    )

    // HEAD/gitdir metadata writes land as new files in the entry dir, which
    // bumps the entry dir mtime the poller compares.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await writeFile(join(entry, 'HEAD'), 'ref: refs/heads/main')
    await waitForEvents(received, (flat) =>
      flat.some((event) => event.type === 'update' && event.path === entry)
    )

    await rm(entry, { recursive: true })
    await waitForEvents(received, (flat) =>
      flat.some((event) => event.type === 'delete' && event.path === entry)
    )
  })

  it('reports primary-checkout HEAD changes via polling', async () => {
    const commonDir = await makeRoot()
    const received: WorktreeBasePollEvent[][] = []
    const target = makeTarget('git-common', commonDir)
    const poller = await startWorktreeBaseDirectoryPoller(
      target,
      () => target.repos,
      (events) => received.push(events),
      // Force the non-darwin poll path so this test is deterministic on all CI.
      { pollIntervalMs: POLL_MS, platform: 'linux' }
    )
    cleanups.push(() => poller.unsubscribe())

    const headFile = join(commonDir, 'HEAD')
    await writeFile(headFile, 'ref: refs/heads/main')
    await waitForEvents(received, (flat) =>
      flat.some((event) => event.type === 'create' && event.path === headFile)
    )

    // A branch switch rewrites HEAD in place; the mtime diff must surface it.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await writeFile(headFile, 'ref: refs/heads/feature')
    await waitForEvents(received, (flat) =>
      flat.some((event) => event.type === 'update' && event.path === headFile)
    )
  })

  it('emits deletes for all known worktrees when the root vanishes', async () => {
    const root = await makeRoot()
    const worktree = join(root, 'external-5')
    await mkdir(worktree)
    await writeFile(join(worktree, '.git'), 'gitdir: elsewhere')

    const received: WorktreeBasePollEvent[][] = []
    const target = makeTarget('base', root)
    const poller = await startWorktreeBaseDirectoryPoller(
      target,
      () => target.repos,
      (events) => received.push(events),
      { pollIntervalMs: POLL_MS }
    )
    cleanups.push(() => poller.unsubscribe())

    await rm(root, { recursive: true, force: true })
    await waitForEvents(received, (flat) =>
      flat.some((event) => event.type === 'delete' && event.path === worktree)
    )
  })

  describe.runIf(process.platform === 'darwin')('macOS narrow git-common stream', () => {
    it('delivers instant add/update/remove without polling', async () => {
      const commonDir = await makeRoot()
      await mkdir(join(commonDir, 'worktrees'))
      const received: WorktreeBasePollEvent[][] = []
      const target = makeTarget('git-common', commonDir)
      const poller = await startWorktreeBaseDirectoryPoller(
        target,
        () => target.repos,
        (events) => received.push(events),
        { pollIntervalMs: POLL_MS, platform: 'darwin' }
      )
      cleanups.push(() => poller.unsubscribe())

      const entry = join(commonDir, 'worktrees', 'wt-a')
      await mkdir(entry)
      await waitForEvents(received, (flat) => flat.some((event) => event.path === entry))

      await writeFile(join(entry, 'HEAD'), 'ref: refs/heads/main')
      await waitForEvents(received, (flat) =>
        flat.some((event) => event.path === join(entry, 'HEAD'))
      )

      await rm(entry, { recursive: true })
      await waitForEvents(received, (flat) =>
        flat.some((event) => event.type === 'delete' && event.path === entry)
      )
    })

    it('covers primary-checkout metadata alongside the narrow stream', async () => {
      const commonDir = await makeRoot()
      await mkdir(join(commonDir, 'worktrees'))
      const received: WorktreeBasePollEvent[][] = []
      const target = makeTarget('git-common', commonDir)
      const poller = await startWorktreeBaseDirectoryPoller(
        target,
        () => target.repos,
        (events) => received.push(events),
        { pollIntervalMs: POLL_MS, platform: 'darwin' }
      )
      cleanups.push(() => poller.unsubscribe())

      // The narrow stream is rooted at worktrees/, so top-level HEAD writes
      // must arrive through the companion metadata poll.
      const headFile = join(commonDir, 'HEAD')
      await writeFile(headFile, 'ref: refs/heads/main')
      await waitForEvents(received, (flat) =>
        flat.some((event) => event.type === 'create' && event.path === headFile)
      )

      await new Promise((resolve) => setTimeout(resolve, 10))
      await writeFile(headFile, 'ref: refs/heads/feature')
      await waitForEvents(received, (flat) =>
        flat.some((event) => event.type === 'update' && event.path === headFile)
      )
    })

    it('arms via existence polling when the worktrees dir appears later', async () => {
      const commonDir = await makeRoot()
      const received: WorktreeBasePollEvent[][] = []
      const target = makeTarget('git-common', commonDir)
      const poller = await startWorktreeBaseDirectoryPoller(
        target,
        () => target.repos,
        (events) => received.push(events),
        { pollIntervalMs: POLL_MS, platform: 'darwin' }
      )
      cleanups.push(() => poller.unsubscribe())

      const worktreesDir = join(commonDir, 'worktrees')
      await mkdir(worktreesDir)
      // The dir appearing is itself surfaced (a first worktree was added).
      await waitForEvents(received, (flat) =>
        flat.some((event) => event.type === 'create' && event.path === worktreesDir)
      )

      // And the narrow stream is live afterwards: entry adds are seen.
      const entry = join(worktreesDir, 'wt-b')
      await mkdir(entry)
      await waitForEvents(received, (flat) => flat.some((event) => event.path === entry))
    })

    it('keeps watching across worktrees dir delete and recreate', async () => {
      const commonDir = await makeRoot()
      await mkdir(join(commonDir, 'worktrees'))
      const received: WorktreeBasePollEvent[][] = []
      const target = makeTarget('git-common', commonDir)
      const poller = await startWorktreeBaseDirectoryPoller(
        target,
        () => target.repos,
        (events) => received.push(events),
        { pollIntervalMs: POLL_MS, platform: 'darwin' }
      )
      cleanups.push(() => poller.unsubscribe())

      // Simulate `git worktree prune` removing the empty dir, then a new add
      // recreating it. The stream re-arms via the existence poll; the repo
      // gets notified on recreate, and subsequent entries are seen live.
      const worktreesDir = join(commonDir, 'worktrees')
      await rm(worktreesDir, { recursive: true })
      await new Promise((resolve) => setTimeout(resolve, 100))
      await mkdir(join(worktreesDir, 'wt-c'), { recursive: true })
      await waitForEvents(received, (flat) =>
        flat.some((event) => event.type === 'create' && event.path === worktreesDir)
      )

      const laterEntry = join(worktreesDir, 'wt-d')
      await mkdir(laterEntry)
      await waitForEvents(received, (flat) => flat.some((event) => event.path === laterEntry))
    })
  })
})
