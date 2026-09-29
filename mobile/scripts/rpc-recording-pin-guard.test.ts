import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../src/shared/child-process/run-process'
import {
  assertReproductionSuitesExist,
  corpusProvenanceChanged,
  removeScratchWorktree,
  REPRODUCTION_SUITES
} from './rpc-recording-pin-guard.mts'
import {
  checkPinReachable,
  gitHubRepositoryFromRemote,
  PIN_MANIFEST,
  pullRequestsWithCommit,
  repinInstruction
} from './rpc-recording-pin-reachability.mts'

const scratch: string[] = []
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd })
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`)
  }
  return result.stdout.trim()
}
/** A repository of our own, so no verdict in this file can depend on — or touch — the real refs. */
async function throwawayRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pin-guard-'))
  scratch.push(directory)
  const repository = join(directory, 'repo')
  await git(directory, 'init', '--quiet', 'repo')
  // `--initial-branch=main` needs git >= 2.28; symbolic-ref before the first commit works on any.
  await git(repository, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  await git(repository, 'config', 'user.email', 'pin-guard@example.invalid')
  await git(repository, 'config', 'user.name', 'Pin Guard')
  return repository
}
async function commit(repository: string, body: string): Promise<string> {
  await writeFile(join(repository, 'product.ts'), `${body}\n`)
  await git(repository, 'add', 'product.ts')
  await git(repository, 'commit', '--quiet', '--no-verify', '--message', body)
  return await git(repository, 'rev-parse', 'HEAD')
}
async function commitAt(repository: string, path: string, body: string): Promise<string> {
  await mkdir(dirname(join(repository, path)), { recursive: true })
  await writeFile(join(repository, path), `${body}\n`)
  await git(repository, 'add', path)
  await git(repository, 'commit', '--quiet', '--no-verify', '--message', path)
  return await git(repository, 'rev-parse', 'HEAD')
}
const RECORDER_FILE = 'mobile/src/test-support/rpc-recording/run-recording.ts'
const GUARD_FILE = 'mobile/scripts/rpc-recording-pin-guard.mts'
/** Every provenance path: the gate refuses to answer when any one of them names nothing. */
async function seedProvenance(repository: string): Promise<string> {
  await commitAt(repository, 'mobile/rpc-foundation/pilot-scenarios.json', 'pin')
  await commitAt(repository, GUARD_FILE, 'guard')
  return await commitAt(repository, RECORDER_FILE, 'recorder')
}
const MISSING_SHA = '0123456789abcdef0123456789abcdef01234567'
function pinManifest(baseline: string): string {
  return JSON.stringify({ baseline, scenarios: [] })
}
/**
 * A behaviour-change branch that pinned its own commit, squash-merged onto main, with the host
 * keeping the branch head at `refs/pull/7/head` the way GitHub does after the branch is gone.
 */
async function squashMergedPin(change: string, subject = `${change} (#7)`) {
  const work = await throwawayRepository()
  await commit(work, 'one')
  await git(work, 'switch', '--quiet', '--create', 'behaviour-change')
  const branchPin = await commit(work, change)
  await commitAt(work, PIN_MANIFEST, pinManifest(branchPin))
  await git(work, 'switch', '--quiet', 'main')
  await git(work, 'merge', '--quiet', '--squash', 'behaviour-change')
  await git(work, 'commit', '--quiet', '--no-verify', '--message', subject)
  const remote = join(work, '..', 'remote.git')
  await git(work, 'init', '--quiet', '--bare', remote)
  await git(work, 'push', '--quiet', remote, 'main', 'behaviour-change:refs/pull/7/head')
  await git(work, 'branch', '--quiet', '-D', 'behaviour-change')
  return { work, remote, branchPin }
}
async function cloneMain(remote: string): Promise<string> {
  const clone = join(remote, '..', `clone-${scratch.length}-${Date.now()}`)
  await git(
    join(remote, '..'),
    'clone',
    '--quiet',
    '--single-branch',
    '--branch',
    'main',
    remote,
    clone
  )
  await git(clone, 'config', 'user.email', 'pin-guard@example.invalid')
  await git(clone, 'config', 'user.name', 'Pin Guard')
  return clone
}
// Stand-ins for GitHub's "pull requests associated with this commit" answer.
const heldByPullRequest7 = async () => [7]
const heldByNoPullRequest = async () => []
const unasked = async (): Promise<number[]> => {
  throw new Error('a pin in this history must not send the guard to GitHub')
}

// File scope, not per-suite: a suite-local hook fires before the later suites have made theirs.
afterAll(async () => {
  for (const directory of scratch) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('recording pin reachability', () => {
  it('passes when the pin is the commit itself', async () => {
    const repository = await throwawayRepository()
    const first = await commit(repository, 'one')
    expect(await checkPinReachable(repository, first, first, unasked)).toMatchObject({ ok: true })
  })

  it('passes on ordinary drift: the tree has moved on, the pin is still reachable', async () => {
    const repository = await throwawayRepository()
    const pin = await commit(repository, 'one')
    const head = await commit(repository, 'two')
    expect(await checkPinReachable(repository, pin, head, unasked)).toMatchObject({ ok: true })
  })

  it('passes on a branch that pinned its own commit, judged against that branch', async () => {
    const repository = await throwawayRepository()
    await commit(repository, 'one')
    await git(repository, 'switch', '--quiet', '--create', 'behaviour-change')
    const branchPin = await commit(repository, 'two')
    const branchHead = await commit(repository, 'three')
    expect(await checkPinReachable(repository, branchPin, branchHead, unasked)).toMatchObject({
      ok: true
    })
  })

  it('passes a branch cut before main repinned, judged against the merge preview', async () => {
    const repository = await throwawayRepository()
    const branchPoint = await commitAt(repository, 'mobile/src/session/route.ts', 'base')
    const mainPin = await commitAt(
      repository,
      'mobile/rpc-foundation/pilot-scenarios.json',
      'repin'
    )
    await git(repository, 'switch', '--quiet', '--create', 'refactor', branchPoint)
    const branchHead = await commitAt(repository, 'mobile/src/session/route.ts', 'migrated')
    await git(repository, 'merge', '--quiet', '--no-edit', 'main')
    const preview = await git(repository, 'rev-parse', 'HEAD')
    // The preview is the tree CI checks out and reads the pin from, so it is the tree to judge.
    expect(await checkPinReachable(repository, mainPin, preview, unasked)).toMatchObject({
      ok: true
    })
    // The head sha would have failed this ordinary branch, and told the author to repin to it.
    expect(
      await checkPinReachable(repository, mainPin, branchHead, heldByNoPullRequest)
    ).toMatchObject({
      ok: false,
      failure: 'not-an-ancestor'
    })
  })

  it('passes once that branch squash-merges, through the head its pull request keeps', async () => {
    const { remote, branchPin } = await squashMergedPin('two')
    // Only main: the branch is deleted, so the pin is nowhere in this clone until it is fetched.
    const clone = await cloneMain(remote)
    expect(await checkPinReachable(clone, branchPin, 'HEAD', heldByPullRequest7)).toMatchObject({
      ok: true,
      pullRequest: 7
    })
    const drifted = await commit(clone, 'later product change on main')
    expect(await checkPinReachable(clone, branchPin, drifted, heldByPullRequest7)).toMatchObject({
      ok: true,
      pullRequest: 7
    })
    // The reproduction checks the pinned tree out next, which needs the fetched commit.
    await git(clone, 'cat-file', '-e', `${branchPin}^{commit}`)
  })

  it('passes a branch opened after that squash, judged against its merge preview', async () => {
    const { remote, branchPin } = await squashMergedPin('two')
    const clone = await cloneMain(remote)
    await git(clone, 'switch', '--quiet', '--create', 'later-branch')
    await commitAt(clone, 'mobile/src/later.ts', 'later branch change')
    await git(clone, 'switch', '--quiet', '--detach', 'main')
    await commit(clone, 'main moved on')
    await git(clone, 'merge', '--quiet', '--no-ff', '--no-edit', 'later-branch')
    expect(await checkPinReachable(clone, branchPin, 'HEAD', heldByPullRequest7)).toMatchObject({
      ok: true,
      pullRequest: 7
    })
  })

  it('passes a squash whose edited title lost its (#n), since GitHub names the pull request', async () => {
    const { remote, branchPin } = await squashMergedPin('two', 'two, title edited at merge')
    const clone = await cloneMain(remote)
    expect(await checkPinReachable(clone, branchPin, 'HEAD', heldByPullRequest7)).toMatchObject({
      ok: true,
      pullRequest: 7
    })
  })

  it('passes through the first associated pull request whose head holds the pin', async () => {
    const { remote, branchPin, work } = await squashMergedPin('two')
    await git(work, 'push', '--quiet', remote, 'main:refs/pull/9/head')
    const clone = await cloneMain(remote)
    expect(await checkPinReachable(clone, branchPin, 'HEAD', async () => [9, 7])).toMatchObject({
      ok: true,
      pullRequest: 7
    })
  })

  it('fails the merge preview of a branch whose rebase dropped the commit it pinned', async () => {
    const { remote } = await squashMergedPin('two')
    const clone = await cloneMain(remote)
    await git(clone, 'switch', '--quiet', '--create', 'rebased')
    const droppedPin = await commit(clone, 'three')
    await commitAt(clone, PIN_MANIFEST, pinManifest(droppedPin))
    await git(clone, 'switch', '--quiet', 'main')
    await commitAt(clone, 'mobile/src/moved.ts', 'main moved on')
    // The rebase rewrites both commits; the manifest still names the one that is gone.
    await git(clone, 'rebase', '--quiet', 'main', 'rebased')
    await git(clone, 'switch', '--quiet', '--detach', 'main')
    await git(clone, 'merge', '--quiet', '--no-ff', '--no-edit', 'rebased')
    // Caught on the pull request: after the squash no head would hold the pin either.
    const verdict = await checkPinReachable(clone, droppedPin, 'HEAD', heldByNoPullRequest)
    expect(verdict).toMatchObject({ ok: false, failure: 'not-an-ancestor' })
    expect(verdict.ok ? '' : verdict.message).toContain('GitHub associates no pull request')
  })

  it("fails when the pull request's head no longer holds the pin", async () => {
    const { remote, branchPin, work } = await squashMergedPin('two')
    // A force-push after pinning: the pin is left in no ref the host keeps.
    await git(work, 'push', '--quiet', '--force', remote, 'main:refs/pull/7/head')
    await git(work, 'push', '--quiet', remote, `${branchPin}:refs/heads/stray`)
    const clone = await cloneMain(remote)
    await git(clone, 'fetch', '--quiet', 'origin', 'stray')
    const verdict = await checkPinReachable(clone, branchPin, 'HEAD', heldByPullRequest7)
    expect(verdict).toMatchObject({ ok: false, failure: 'not-an-ancestor' })
    expect(verdict.ok ? '' : verdict.message).toContain('refs/pull/7/head')
  })

  it('fails once that branch squash-merges if GitHub associates no pull request with it', async () => {
    const repository = await throwawayRepository()
    const base = await commit(repository, 'one')
    await git(repository, 'switch', '--quiet', '--create', 'behaviour-change')
    const branchPin = await commit(repository, 'two')
    await git(repository, 'switch', '--quiet', 'main')
    await git(repository, 'reset', '--quiet', '--hard', base)
    await commitAt(repository, PIN_MANIFEST, pinManifest(branchPin))
    const squashed = await commit(repository, 'two, squashed')
    const verdict = await checkPinReachable(repository, branchPin, squashed, heldByNoPullRequest)
    expect(verdict).toMatchObject({ ok: false, failure: 'not-an-ancestor' })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) {
      return
    }
    expect(verdict.message).toContain(branchPin)
    expect(verdict.message).toContain('GitHub associates no pull request')
    expect(verdict.message).toContain('scripts/rpc-recording.mts --record')
    expect(verdict.message).toContain('mobile/rpc-foundation/pilot-scenarios.json')
  })

  it('fails with the same instruction when the pin is no commit at all', async () => {
    const repository = await throwawayRepository()
    const head = await commit(repository, 'one')
    const verdict = await checkPinReachable(repository, MISSING_SHA, head, heldByNoPullRequest)
    expect(verdict).toMatchObject({ ok: false, failure: 'unreachable' })
    expect(verdict.ok ? '' : verdict.message).toContain('scripts/rpc-recording.mts --record')
  })

  it('lets a failed GitHub lookup propagate, never a pass or a repin instruction', async () => {
    const { remote, branchPin } = await squashMergedPin('two')
    const clone = await cloneMain(remote)
    const broken = async (): Promise<number[]> => {
      throw new Error('GitHub answered 502')
    }
    await expect(checkPinReachable(clone, branchPin, 'HEAD', broken)).rejects.toThrow(
      'GitHub answered 502'
    )
  })

  it('refuses to answer on a shallow clone instead of trusting grafted history', async () => {
    const repository = await throwawayRepository()
    const pin = await commit(repository, 'one')
    await commit(repository, 'two')
    const head = await commit(repository, 'three')
    const clone = join(repository, '..', 'shallow')
    await git(repository, 'clone', '--quiet', '--depth', '1', `file://${repository}`, clone)
    // The pin is real and reachable in the full repository; only the missing history hides it.
    expect(await checkPinReachable(repository, pin, head, unasked)).toMatchObject({ ok: true })
    const verdict = await checkPinReachable(clone, pin, 'HEAD', unasked)
    expect(verdict).toMatchObject({ ok: false, failure: 'shallow' })
    expect(verdict.ok ? '' : verdict.message).toContain('fetch-depth: 0')
  })

  it('names the head and the pin in the instruction', () => {
    expect(
      repinInstruction('a'.repeat(40), 'b'.repeat(40), 'is not a commit in this repository at all')
    ).toContain(`git switch -c repin-rpc-recording ${'b'.repeat(40)}`)
  })
})

describe("GitHub's pull requests for a pinned commit", () => {
  const pin = 'a'.repeat(40)
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('asks with the token when one is set and reads the pull request numbers', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'stablyai/orca')
    vi.stubEnv('GITHUB_TOKEN', 'test-token')
    const fetch = answer(200, [{ number: 22762 }, { number: 5 }])
    vi.stubGlobal('fetch', fetch)
    expect(await pullRequestsWithCommit('/unused', pin)).toEqual([22762, 5])
    expect(fetch).toHaveBeenCalledWith(
      `https://api.github.com/repos/stablyai/orca/commits/${pin}/pulls`,
      expect.objectContaining({
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer test-token'
        }
      })
    )
  })

  it('reads no pull request for a commit GitHub has never seen', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'stablyai/orca')
    vi.stubGlobal('fetch', answer(422, { message: `No commit found for SHA: ${pin}` }))
    expect(await pullRequestsWithCommit('/unused', pin)).toEqual([])
  })

  it('names the rate limit when GitHub refuses a call made without a token', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'stablyai/orca')
    vi.stubEnv('GITHUB_TOKEN', '')
    vi.stubEnv('GH_TOKEN', '')
    vi.stubGlobal('fetch', answer(403, { message: 'API rate limit exceeded' }))
    await expect(pullRequestsWithCommit('/unused', pin)).rejects.toThrow(
      /answered 403[\s\S]*API rate limit exceeded[\s\S]*set GITHUB_TOKEN or GH_TOKEN/
    )
  })

  it('reads owner and repo from https and ssh remotes, and nothing from another host', () => {
    expect(gitHubRepositoryFromRemote('https://github.com/stablyai/orca.git\n')).toBe(
      'stablyai/orca'
    )
    expect(gitHubRepositoryFromRemote('https://github.com/stablyai/orca')).toBe('stablyai/orca')
    expect(gitHubRepositoryFromRemote('git@github.com:stablyai/orca.git')).toBe('stablyai/orca')
    expect(gitHubRepositoryFromRemote('ssh://git@github.com/stablyai/orca.git')).toBe(
      'stablyai/orca'
    )
    expect(gitHubRepositoryFromRemote('/tmp/remote.git')).toBeNull()
  })
})

describe('what a reproduction reads from the candidate tree', () => {
  it('skips the run when only product sources moved', async () => {
    const repository = await throwawayRepository()
    await seedProvenance(repository)
    const base = await commitAt(repository, 'mobile/src/session/route.ts', 'before')
    await commitAt(repository, 'mobile/src/session/route.ts', 'after')
    expect(await corpusProvenanceChanged(repository, base)).toBe(false)
  })

  it('runs when a golden moved', async () => {
    const repository = await throwawayRepository()
    await seedProvenance(repository)
    const base = await commitAt(repository, 'mobile/rpc-foundation/goldens/a.json', '{}')
    await commitAt(repository, 'mobile/rpc-foundation/goldens/a.json', '{"spliced": true}')
    expect(await corpusProvenanceChanged(repository, base)).toBe(true)
  })

  it('runs when the pin itself moved', async () => {
    const repository = await throwawayRepository()
    await seedProvenance(repository)
    const base = await commitAt(repository, 'mobile/rpc-foundation/pilot-scenarios.json', 'one')
    await commitAt(repository, 'mobile/rpc-foundation/pilot-scenarios.json', 'two')
    expect(await corpusProvenanceChanged(repository, base)).toBe(true)
  })

  it('ignores a corpus change the base branch made without this branch', async () => {
    const repository = await throwawayRepository()
    await seedProvenance(repository)
    const branchPoint = await commitAt(repository, 'mobile/rpc-foundation/goldens/a.json', '{}')
    await commitAt(repository, 'mobile/rpc-foundation/goldens/b.json', '{}')
    const baseTip = await git(repository, 'rev-parse', 'HEAD')
    await git(repository, 'switch', '--quiet', '--create', 'refactor', branchPoint)
    await commitAt(repository, 'mobile/src/session/route.ts', 'migrated')
    expect(await corpusProvenanceChanged(repository, baseTip)).toBe(false)
  })

  it('runs when the recorder moved, because every golden pins it by digest', async () => {
    const repository = await throwawayRepository()
    const base = await seedProvenance(repository)
    await commitAt(repository, RECORDER_FILE, 'two')
    expect(await corpusProvenanceChanged(repository, base)).toBe(true)
  })

  it('runs when the guard itself moved, because it decides the skip and drives the run', async () => {
    const repository = await throwawayRepository()
    const base = await seedProvenance(repository)
    await commitAt(repository, GUARD_FILE, 'changed')
    expect(await corpusProvenanceChanged(repository, base)).toBe(true)
  })

  it('runs on an untracked golden, which no diff of tracked paths can see', async () => {
    const repository = await throwawayRepository()
    const base = await seedProvenance(repository)
    const golden = join(repository, 'mobile/rpc-foundation/goldens/local.json')
    await mkdir(dirname(golden), { recursive: true })
    await writeFile(golden, '{}\n')
    // The overlay copy and the census both read the directory as it sits on disk.
    expect(await corpusProvenanceChanged(repository, base)).toBe(true)
  })

  it('refuses to answer when a provenance path names nothing, instead of skipping forever', async () => {
    const repository = await throwawayRepository()
    const base = await seedProvenance(repository)
    await git(repository, 'mv', 'mobile/rpc-foundation', 'mobile/rpc-corpus')
    await git(repository, 'commit', '--quiet', '--no-verify', '--message', 'rename the corpus')
    await expect(corpusProvenanceChanged(repository, base)).rejects.toThrow('not a tracked path')
  })
})

describe('scratch worktree teardown', () => {
  it('leaves an unrelated worktree registered when its directory is missing', async () => {
    const repository = await throwawayRepository()
    await commit(repository, 'one')
    const trees = join(repository, '..', 'trees')
    for (const name of ['scratch', 'kept', 'unmounted']) {
      await git(repository, 'worktree', 'add', '--quiet', '--detach', join(trees, name))
    }
    // Stands in for a worktree on an unmounted volume: `git worktree prune` would deregister it.
    await rm(join(trees, 'unmounted'), { recursive: true, force: true })
    await removeScratchWorktree(repository, join(trees, 'scratch'))
    const registered = await git(repository, 'worktree', 'list', '--porcelain')
    expect(registered).toContain('trees/kept')
    expect(registered).toContain('trees/unmounted')
    expect(registered).not.toContain('trees/scratch')
  })
})

describe('the suites a reproduction runs', () => {
  const overlay = 'mobile/src/test-support/rpc-recording'

  it('every name resolves to a file in this repository', () => {
    expect(() => assertReproductionSuitesExist(resolve(import.meta.dirname, '../..'))).not.toThrow()
  })

  it('throws for the one that drifted, rather than letting vitest pass over it', async () => {
    for (const renamed of REPRODUCTION_SUITES) {
      const root = await mkdtemp(join(tmpdir(), 'pin-guard-suites-'))
      scratch.push(root)
      await mkdir(join(root, overlay), { recursive: true })
      for (const suite of REPRODUCTION_SUITES.filter((name) => name !== renamed)) {
        await writeFile(join(root, overlay, suite), '')
      }
      expect(() => assertReproductionSuitesExist(root)).toThrow(renamed)
    }
  })
})
