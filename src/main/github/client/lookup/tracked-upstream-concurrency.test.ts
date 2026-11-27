import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type PendingGit = {
  args: string[]
  cwd: string
  canStart?: () => boolean
  observeGitRuntime?: (runsIn: string) => void
  resolve: (value: { stdout: string; stderr: string }) => void
  reject: (error: Error) => void
}

const h = vi.hoisted(() => {
  const state: {
    pending: PendingGit[]
    signature: string | undefined
    holdSignatures: boolean
    signatureGates: ((value: string | undefined) => void)[]
  } = { pending: [], signature: 'S0', holdSignatures: false, signatureGates: [] }
  return state
})

vi.mock('../../../git/command-runner/git-exec-file', () => ({
  gitExecFileAsync: (
    args: string[],
    options: Pick<PendingGit, 'cwd' | 'observeGitRuntime' | 'canStart'>
  ) =>
    new Promise((resolve, reject) => {
      h.pending.push({ args, ...options, resolve, reject })
    })
}))

vi.mock('../../repositories/local-git-config-signature', () => ({
  readLocalGitConfigSignature: () =>
    h.holdSignatures
      ? new Promise<string | undefined>((resolve) => h.signatureGates.push(resolve))
      : Promise.resolve(h.signature)
}))

import { setLocalGitRuntimeRouter } from '../../../git/command-runner/host-routing/local-git-runtime-route'
import { getReviewBranchSource, getTrackedUpstreamBranch } from './tracked-upstream-branch'
import {
  TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS,
  getTrackedUpstreamRoute,
  publishTrackedUpstreamSnapshot,
  trackedUpstreamSnapshotCache,
  trackedUpstreamSnapshotGenerations,
  trackedUpstreamSnapshotInFlight
} from './tracked-upstream-cache'

const REPO = '/fixture/repo'
const WORKTREE = '/fixture/wt'
const ORIGIN = 'https://example.invalid/acme/app.git'
const FORK = 'https://example.invalid/fork/app.git'
const REMOTES = [
  `origin\t${ORIGIN} (fetch)`,
  `origin\t${ORIGIN} (push)`,
  `fork\t${FORK} (fetch)`,
  `fork\t${FORK} (push)`
].join('\n')

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function take(subcommand: string, cwd = REPO): Promise<PendingGit> {
  await flush()
  const index = h.pending.findIndex((call) => call.args[0] === subcommand && call.cwd === cwd)
  if (index === -1) {
    throw new Error(`No pending git ${subcommand} in ${cwd}`)
  }
  return h.pending.splice(index, 1)[0]
}

async function answerRefs(upstream: string, cwd = REPO): Promise<void> {
  ;(await take('for-each-ref', cwd)).resolve({
    stdout: `refs/heads/feature\0${upstream}\n`,
    stderr: ''
  })
}

async function answerResolver(pushDefault?: string, cwd = REPO): Promise<void> {
  const config = pushDefault ? `remote.pushdefault\n${pushDefault}\0` : ''
  ;(await take('config', cwd)).resolve({ stdout: config, stderr: '' })
  ;(await take('remote', cwd)).resolve({ stdout: REMOTES, stderr: '' })
}

async function releaseSignature(index: number, value: string | undefined): Promise<void> {
  await flush()
  const gate = h.signatureGates[index]
  if (!gate) {
    throw new Error(`No signature read #${index}`)
  }
  gate(value)
}

function entryFor(path = REPO) {
  return trackedUpstreamSnapshotCache.get(getTrackedUpstreamRoute(path).cacheKey)
}

async function publishUpstreamOnly(upstream = 'refs/remotes/origin/feature'): Promise<void> {
  const lookup = getTrackedUpstreamBranch(REPO, 'feature')
  await answerRefs(upstream)
  await lookup
}

const originalPlatform = process.platform

beforeEach(() => {
  h.pending.length = 0
  h.signature = 'S0'
  h.holdSignatures = false
  h.signatureGates.length = 0
  trackedUpstreamSnapshotCache.clear()
  trackedUpstreamSnapshotInFlight.clear()
  trackedUpstreamSnapshotGenerations.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  setLocalGitRuntimeRouter(null)
})

describe('tracked upstream snapshot concurrency', () => {
  it('runs separate in-flight probes for sibling worktrees and resolves each with its own data', async () => {
    const main = getTrackedUpstreamBranch(REPO, 'feature')
    const linked = getTrackedUpstreamBranch(WORKTREE, 'feature')
    await flush()
    expect(h.pending.map((call) => call.cwd).sort()).toEqual([WORKTREE, REPO].sort())
    await answerRefs('refs/remotes/fork/fork-feature', WORKTREE)
    await answerRefs('refs/remotes/origin/feature', REPO)
    await expect(linked).resolves.toEqual({ remoteName: 'fork', branchName: 'fork-feature' })
    await expect(main).resolves.toEqual({ remoteName: 'origin', branchName: 'feature' })
  })

  it('does not let a stale hit delete an entry a newer probe published meanwhile', async () => {
    await publishUpstreamOnly()
    h.signature = 'S1'
    h.holdSignatures = true
    const staleHit = getTrackedUpstreamBranch(REPO, 'feature')
    await flush()
    const forced = getTrackedUpstreamBranch(REPO, 'feature', null, {}, true)
    await releaseSignature(1, 'S1')
    await answerRefs('refs/remotes/fork/fork-feature')
    await releaseSignature(2, 'S1')
    await expect(forced).resolves.toEqual({ remoteName: 'fork', branchName: 'fork-feature' })
    const published = entryFor()
    expect(published?.gitConfigSignature).toBe('S1')

    h.holdSignatures = false
    // The stale hit's signature check (made before the forced publish) now completes: mismatch.
    await releaseSignature(0, 'S1')
    await flush()
    expect(entryFor()).toBe(published)
    await answerRefs('refs/remotes/fork/fork-feature')
    await expect(staleHit).resolves.toEqual({ remoteName: 'fork', branchName: 'fork-feature' })
  })

  it('retries a torn probe once and returns the coherent second read', async () => {
    const lookup = getReviewBranchSource(REPO, 'feature')
    await flush()
    h.signature = 'S1'
    await answerRefs('refs/remotes/origin/feature')
    await answerResolver('fork')
    expect(entryFor()).toBeUndefined()
    await answerRefs('refs/remotes/origin/feature')
    await answerResolver()
    await expect(lookup).resolves.toMatchObject({ remoteName: 'origin' })
    expect(entryFor()?.gitConfigSignature).toBe('S1')
  })

  it('fails a review lookup that stays torn, but keeps the single-process upstream read', async () => {
    const review = expect(getReviewBranchSource(REPO, 'feature')).rejects.toThrow(
      'Cannot establish the branch review source'
    )
    await flush()
    h.signature = 'S1'
    await answerRefs('refs/remotes/origin/feature')
    await answerResolver()
    await flush()
    h.signature = 'S2'
    await answerRefs('refs/remotes/origin/feature')
    await answerResolver()
    await review

    const upstream = getTrackedUpstreamBranch(REPO, 'feature')
    await flush()
    h.signature = 'S3'
    await answerRefs('refs/remotes/origin/feature')
    await flush()
    h.signature = 'S4'
    await answerRefs('refs/remotes/fork/fork-feature')
    await expect(upstream).resolves.toEqual({ remoteName: 'fork', branchName: 'fork-feature' })
    expect(entryFor()).toBeUndefined()
    await flush()
    expect(h.pending).toEqual([])
  })

  it('makes a waiter that joined after a config edit re-probe instead of taking the older read', async () => {
    const first = getTrackedUpstreamBranch(REPO, 'feature')
    await flush()
    h.holdSignatures = true
    await answerRefs('refs/remotes/origin/feature')
    // The prober's end-signature read happened before the edit; the waiter arrives after it.
    h.signature = 'S1'
    const waiter = getTrackedUpstreamBranch(REPO, 'feature')
    await flush()
    h.holdSignatures = false
    await releaseSignature(0, 'S0')
    await expect(first).resolves.toEqual({ remoteName: 'origin', branchName: 'feature' })
    await answerRefs('refs/remotes/fork/fork-feature')
    await expect(waiter).resolves.toEqual({ remoteName: 'fork', branchName: 'fork-feature' })
    expect(entryFor()?.gitConfigSignature).toBe('S1')
  })

  it('does not adopt a newer publication that was edited after it was published', async () => {
    h.holdSignatures = true
    const older = getTrackedUpstreamBranch(REPO, 'feature')
    await releaseSignature(0, 'S0')
    const forced = getTrackedUpstreamBranch(REPO, 'feature', null, {}, true)
    await releaseSignature(1, 'S0')
    await flush()
    const [olderRefs, forcedRefs] = h.pending.splice(0, 2)
    forcedRefs.resolve({
      stdout: 'refs/heads/feature\0refs/remotes/fork/fork-feature\n',
      stderr: ''
    })
    await releaseSignature(2, 'S0')
    await expect(forced).resolves.toEqual({ remoteName: 'fork', branchName: 'fork-feature' })

    olderRefs.resolve({ stdout: 'refs/heads/feature\0refs/remotes/origin/feature\n', stderr: '' })
    await flush()
    // The older probe's end read saw S0; the edit lands before it checks the forced publication.
    h.signature = 'S1'
    h.holdSignatures = false
    await releaseSignature(3, 'S0')
    await expect(older).resolves.toEqual({ remoteName: 'origin', branchName: 'feature' })
  })

  it('does not adopt a newer publication that expires during validation', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const older = getTrackedUpstreamBranch(REPO, 'feature')
    await flush()
    const forced = getTrackedUpstreamBranch(REPO, 'feature', null, {}, true)
    await flush()
    const [olderRefs, forcedRefs] = h.pending.splice(0, 2)
    forcedRefs.resolve({
      stdout: 'refs/heads/feature\0refs/remotes/fork/fork-feature\n',
      stderr: ''
    })
    await expect(forced).resolves.toEqual({ remoteName: 'fork', branchName: 'fork-feature' })
    h.holdSignatures = true
    olderRefs.resolve({ stdout: 'refs/heads/feature\0refs/remotes/origin/feature\n', stderr: '' })
    await releaseSignature(0, 'S0')
    await flush()
    clock.mockReturnValue(now + TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS + 1)
    await releaseSignature(1, 'S0')
    await expect(older).resolves.toEqual({ remoteName: 'origin', branchName: 'feature' })
  })

  it('adopts a newer valid publication when a force superseded the probe', async () => {
    const older = getTrackedUpstreamBranch(REPO, 'feature')
    const waiter = getTrackedUpstreamBranch(REPO, 'feature')
    await flush()
    const forced = getTrackedUpstreamBranch(REPO, 'feature', null, {}, true)
    await flush()
    const [olderRefs, forcedRefs] = h.pending.splice(0, 2)
    forcedRefs.resolve({
      stdout: 'refs/heads/feature\0refs/remotes/fork/fork-feature\n',
      stderr: ''
    })
    await expect(forced).resolves.toEqual({ remoteName: 'fork', branchName: 'fork-feature' })
    olderRefs.resolve({ stdout: 'refs/heads/feature\0refs/remotes/origin/feature\n', stderr: '' })
    await expect(older).resolves.toEqual({ remoteName: 'fork', branchName: 'fork-feature' })
    // The waiter joined the older probe before the force and takes that coherent read.
    await expect(waiter).resolves.toEqual({ remoteName: 'origin', branchName: 'feature' })
    expect(entryFor()?.rawUpstreamsByBranchName?.get('feature')).toBe(
      'refs/remotes/fork/fork-feature'
    )
  })

  it('rejects a superseded signed join that expires while its signature is checked', async () => {
    const now = 1_000_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const older = getTrackedUpstreamBranch(REPO, 'feature')
    const olderRefs = await take('for-each-ref')
    const waiter = getTrackedUpstreamBranch(REPO, 'feature')
    const forced = getTrackedUpstreamBranch(REPO, 'feature', null, {}, true)
    const forcedRefs = await take('for-each-ref')

    const completionTime = now + 2 * TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS
    clock.mockReturnValue(completionTime)
    h.holdSignatures = true
    olderRefs.resolve({ stdout: 'refs/heads/feature\0refs/remotes/origin/feature\n', stderr: '' })
    await releaseSignature(0, 'S0')
    await expect(older).resolves.toEqual({ remoteName: 'origin', branchName: 'feature' })
    expect(entryFor()).toBeUndefined()
    expect(h.signatureGates).toHaveLength(2)
    clock.mockReturnValue(completionTime + TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS)
    h.holdSignatures = false
    await releaseSignature(1, 'S0')

    forcedRefs.resolve({ stdout: 'refs/heads/feature\0refs/remotes/fork/current\n', stderr: '' })
    await expect(forced).resolves.toEqual({ remoteName: 'fork', branchName: 'current' })
    await expect(waiter).resolves.toEqual({ remoteName: 'fork', branchName: 'current' })
  })

  it('re-probes when a second unsigned join is already expired', async () => {
    const now = 1_000_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const repo = '\\\\server\\share\\app'
    const older = getTrackedUpstreamBranch(repo, 'other')
    const olderRefs = await take('for-each-ref', repo)
    const waiter = getTrackedUpstreamBranch(repo, 'feature')
    const forced = getTrackedUpstreamBranch(repo, 'feature', null, {}, true)
    const forcedRefs = await take('for-each-ref', repo)
    const secondProbe = trackedUpstreamSnapshotInFlight.get(getTrackedUpstreamRoute(repo).cacheKey)
    if (!secondProbe) {
      throw new Error('Expected the forced probe')
    }
    // Advance after the probe settles, ahead of the waiter attached after the first join.
    const elapsed = secondProbe.then(() => {
      clock.mockReturnValue(now + TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS)
    })
    olderRefs.resolve({ stdout: 'refs/heads/other\0refs/remotes/origin/other\n', stderr: '' })
    await expect(older).resolves.toEqual({ remoteName: 'origin', branchName: 'other' })
    await flush()

    forcedRefs.resolve({ stdout: 'refs/heads/feature\0refs/remotes/origin/expired\n', stderr: '' })
    await expect(forced).resolves.toEqual({ remoteName: 'origin', branchName: 'expired' })
    await elapsed
    await flush()
    h.pending
      .shift()
      ?.resolve({ stdout: 'refs/heads/feature\0refs/remotes/fork/current\n', stderr: '' })
    await expect(waiter).resolves.toEqual({ remoteName: 'fork', branchName: 'current' })
  })

  it('does not adopt a newer host publication without a signature, but serves it on a warm hit', async () => {
    h.signature = undefined
    const older = getTrackedUpstreamBranch(REPO, 'feature')
    const olderRefs = await take('for-each-ref')
    const forced = getTrackedUpstreamBranch(REPO, 'feature', null, {}, true)
    await answerRefs('refs/remotes/fork/fork-feature')
    await expect(forced).resolves.toEqual({ remoteName: 'fork', branchName: 'fork-feature' })
    olderRefs.resolve({ stdout: 'refs/heads/feature\0refs/remotes/origin/feature\n', stderr: '' })
    await expect(older).resolves.toEqual({ remoteName: 'origin', branchName: 'feature' })
    await expect(getTrackedUpstreamBranch(REPO, 'feature')).resolves.toEqual({
      remoteName: 'fork',
      branchName: 'fork-feature'
    })
  })

  it('keeps a valid upstream entry when the review-resolver upgrade fails', async () => {
    await publishUpstreamOnly()
    const entry = entryFor()
    const review = expect(getReviewBranchSource(REPO, 'feature')).rejects.toThrow(
      'Cannot establish the branch review source'
    )
    await answerRefs('refs/remotes/origin/feature')
    ;(await take('config')).reject(new Error('config unreadable'))
    await review
    expect(entryFor()).toBe(entry)

    await expect(getTrackedUpstreamBranch(REPO, 'feature')).resolves.toEqual({
      remoteName: 'origin',
      branchName: 'feature'
    })
    await flush()
    expect(h.pending).toEqual([])
  })

  it('keeps a valid upstream entry available during and after a failed forced review refresh', async () => {
    await publishUpstreamOnly()
    const entry = entryFor()
    const review = expect(getReviewBranchSource(REPO, 'feature', null, {}, true)).rejects.toThrow(
      'Cannot establish the branch review source'
    )
    const refs = await take('for-each-ref')
    expect(entryFor()).toBe(entry)
    await expect(getTrackedUpstreamBranch(REPO, 'feature')).resolves.toEqual({
      remoteName: 'origin',
      branchName: 'feature'
    })
    refs.resolve({ stdout: 'refs/heads/feature\0refs/remotes/fork/unpublished\n', stderr: '' })
    ;(await take('config')).reject(new Error('config unreadable'))
    await review
    expect(entryFor()).toBe(entry)
    await expect(getTrackedUpstreamBranch(REPO, 'feature')).resolves.toEqual({
      remoteName: 'origin',
      branchName: 'feature'
    })
    expect(h.pending).toEqual([])
  })

  it('rejects an older serving publication when a non-force superseded probe completes first', async () => {
    const leader = getTrackedUpstreamBranch(REPO, 'feature')
    const leadRefs = await take('for-each-ref')
    const firstWaiter = getTrackedUpstreamBranch(REPO, 'feature')
    const older = getTrackedUpstreamBranch(REPO, 'feature')
    const newer = getTrackedUpstreamBranch(REPO, 'feature')
    leadRefs.reject(new Error('unreadable refs'))
    await expect(leader).resolves.toBeNull()
    const firstWaiterRefs = await take('for-each-ref')
    const { cacheKey } = getTrackedUpstreamRoute(REPO)
    // Both waiters are on their second join. The valid entry predates their own probes.
    publishTrackedUpstreamSnapshot(cacheKey, {
      expiresAt: Date.now() + TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS,
      gitConfigSignature: 'S0',
      upstreamsByBranchName: new Map([['feature', { remoteName: 'origin', branchName: 'stale' }]])
    })
    const persisted = entryFor()
    firstWaiterRefs.reject(new Error('unreadable refs'))
    await expect(firstWaiter).resolves.toBeNull()
    const olderRefs = await take('for-each-ref')
    const newerRefs = await take('for-each-ref')

    olderRefs.resolve({ stdout: 'refs/heads/feature\0refs/remotes/fork/earlier\n', stderr: '' })
    await expect(older).resolves.toEqual({ remoteName: 'fork', branchName: 'earlier' })
    expect(entryFor()).toBe(persisted)
    newerRefs.resolve({ stdout: 'refs/heads/feature\0refs/remotes/fork/later\n', stderr: '' })
    await expect(newer).resolves.toEqual({ remoteName: 'fork', branchName: 'later' })
    expect(entryFor()?.rawUpstreamsByBranchName?.get('feature')).toBe('refs/remotes/fork/later')
  })

  it('does not publish a probe whose Git route changed mid-probe, then retries on the new route', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    let distro: string | undefined
    setLocalGitRuntimeRouter(() => distro)
    const repo = 'C:\\fixture\\repo'
    const lookup = getTrackedUpstreamBranch(repo, 'feature')
    expect(getTrackedUpstreamRoute(repo).runsIn).toBe('host')
    const first = await take('for-each-ref', repo)
    distro = 'Ubuntu'
    first.observeGitRuntime?.('wsl:ubuntu')
    expect(first.canStart?.()).toBe(false)
    first.reject(new Error('Git runtime changed before spawn'))
    expect(trackedUpstreamSnapshotCache.size).toBe(0)
    await answerRefs('refs/remotes/fork/fork-feature', repo)
    await expect(lookup).resolves.toEqual({ remoteName: 'fork', branchName: 'fork-feature' })
    expect([...trackedUpstreamSnapshotCache.keys()]).toEqual([`wsl:ubuntu\0${repo}`])
    expect(
      trackedUpstreamSnapshotCache.get(`wsl:ubuntu\0${repo}`)?.gitConfigSignature
    ).toBeUndefined()
  })

  it('stops a mixed-route review before the remaining resolver Git command', async () => {
    const lookup = getReviewBranchSource(REPO, 'feature')
    await answerRefs('refs/remotes/origin/feature')
    const config = await take('config')
    config.observeGitRuntime?.('wsl:ubuntu')
    config.resolve({ stdout: 'remote.pushdefault\nfork\0', stderr: '' })
    const retry = await take('for-each-ref')
    expect(h.pending).toEqual([])
    expect(entryFor()).toBeUndefined()
    retry.resolve({ stdout: 'refs/heads/feature\0refs/remotes/origin/feature\n', stderr: '' })
    await answerResolver()
    await expect(lookup).resolves.toMatchObject({ remoteName: 'origin', urls: [ORIGIN] })
    expect(entryFor()?.gitConfigSignature).toBe('S0')
  })

  it('retries a warm-hit route flip without probing the old route or evicting its entry', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    let distro: string | undefined
    setLocalGitRuntimeRouter(() => distro)
    const repo = 'C:\\fixture\\repo'
    const hostKey = getTrackedUpstreamRoute(repo).cacheKey
    const initial = getTrackedUpstreamBranch(repo, 'feature')
    await answerRefs('refs/remotes/origin/feature', repo)
    await initial
    const host = trackedUpstreamSnapshotCache.get(hostKey)
    h.holdSignatures = true
    const hit = getTrackedUpstreamBranch(repo, 'feature')
    await flush()
    distro = 'Ubuntu'
    h.holdSignatures = false
    await releaseSignature(0, 'S0')
    const refs = await take('for-each-ref', repo)
    refs.observeGitRuntime?.('wsl:ubuntu')
    refs.resolve({ stdout: 'refs/heads/feature\0refs/remotes/fork/current\n', stderr: '' })
    await flush()

    expect(h.pending).toEqual([])
    await expect(hit).resolves.toEqual({ remoteName: 'fork', branchName: 'current' })
    expect(trackedUpstreamSnapshotCache.get(hostKey)).toBe(host)
    expect(entryFor(repo)?.gitConfigSignature).toBeUndefined()
  })

  it('lets a forced lookup bypass an in-flight probe without the old probe publishing', async () => {
    const older = getTrackedUpstreamBranch(REPO, 'feature')
    await flush()
    const forced = getTrackedUpstreamBranch(REPO, 'feature', null, {}, true)
    await flush()
    expect(h.pending.filter((call) => call.args[0] === 'for-each-ref')).toHaveLength(2)
    const [olderRefs, forcedRefs] = h.pending.splice(0, 2)
    olderRefs.resolve({ stdout: 'refs/heads/feature\0refs/remotes/origin/feature\n', stderr: '' })
    await expect(older).resolves.toEqual({ remoteName: 'origin', branchName: 'feature' })
    expect(entryFor()).toBeUndefined()
    forcedRefs.resolve({
      stdout: 'refs/heads/feature\0refs/remotes/fork/fork-feature\n',
      stderr: ''
    })
    await expect(forced).resolves.toEqual({ remoteName: 'fork', branchName: 'fork-feature' })
    expect(entryFor()?.rawUpstreamsByBranchName?.get('feature')).toBe(
      'refs/remotes/fork/fork-feature'
    )
  })
})
