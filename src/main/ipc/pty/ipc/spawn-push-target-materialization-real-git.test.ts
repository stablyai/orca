// Real-binary coverage for #17828's remaining gap: the mocked-underlying-trigger suite in
// `spawn-push-target-materialization.test.ts` proves the wiring/delegation logic, but not
// that a `pty:spawn`-originated terminal -- the desktop GUI's own terminal path, previously
// uncovered -- actually ends up with a configured upstream against real git. No mocks here:
// this exercises the real `triggerTerminalSpawnPushTargetMaterialization` and real
// `materializeWorktreePushTargetRemote`, driven only through `runPtyIpcSpawn`'s hook.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { Store } from '../../../persistence'
import type { PtySpawnIpcDeps } from './spawn-types'
import { triggerPtySpawnPushTargetMaterialization } from './spawn-push-target-materialization'

const execFileAsync = promisify(execFile)

const REPO_ID = 'repo-1'
const FORK_REMOTE = 'pr-contributor-orca'
const TRACKED_BRANCH = 'contributor/fix'

let scratchDir = ''
let repoPath = ''
let forkPath = ''
let worktreeId = ''
let mainBranch = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

async function setIdentity(cwd: string): Promise<void> {
  await git(['config', 'user.name', 'Orca Test'], cwd)
  await git(['config', 'user.email', 'orca@example.test'], cwd)
  await git(['config', 'commit.gpgSign', 'false'], cwd)
}

beforeEach(async () => {
  // realpath: macOS hands out /var/... temp paths while Git reports /private/var/...
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-pty-spawn-push-target-')))
  repoPath = join(scratchDir, 'repo')
  forkPath = join(scratchDir, 'fork')
  worktreeId = `${REPO_ID}::${repoPath}`

  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q'], repoPath)
  await setIdentity(repoPath)
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'], repoPath)
  await git(['commit', '-qm', 'seed'], repoPath)
  mainBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)).trim()

  await git(['clone', '-q', repoPath, forkPath], scratchDir)
  await setIdentity(forkPath)
  await git(['checkout', '-qb', TRACKED_BRANCH], forkPath)
  await writeFile(join(forkPath, 'fix.txt'), 'fix\n')
  await git(['add', '-A'], forkPath)
  await git(['commit', '-qm', 'fix'], forkPath)
})

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true })
})

function forkTarget(): GitPushTarget {
  return { remoteName: FORK_REMOTE, branchName: TRACKED_BRANCH, remoteUrl: forkPath }
}

function depsFor(
  pushTarget: GitPushTarget,
  setWorktreeMeta?: Store['setWorktreeMeta']
): {
  deps: PtySpawnIpcDeps
  meta: Record<string, WorktreeMeta>
} {
  const meta: Record<string, WorktreeMeta> = { [worktreeId]: { pushTarget } as WorktreeMeta }
  const store = {
    getWorktreeMeta: (id: string) => meta[id],
    getRepo: (id: string) => ({ id, path: repoPath, connectionId: null }) as unknown as Repo,
    getAllWorktreeMeta: () => meta,
    ...(setWorktreeMeta ? { setWorktreeMeta } : {})
  } as unknown as Store
  return { deps: { store } as unknown as PtySpawnIpcDeps, meta }
}

describe('triggerPtySpawnPushTargetMaterialization (real git fixture)', () => {
  it('materializes the fork remote and configures the upstream for a pty:spawn-originated terminal', async () => {
    // Why: not just that materialization was *called* -- the coordinator's bar for closing
    // the gap is a real, git-verified configured upstream reachable from a pty:spawn arg set.
    // Pre-seeds the remote so materialize takes the short-circuit branch (worktree-remote.ts):
    // real `remote add`/`fetch` against a fabricated fork is already covered against real git by
    // worktree-push-target-refspec-real-git.test.ts; the top-level entry point this hook calls
    // additionally validates `remoteUrl` against a GitHub URL shape, which a local fixture path
    // can never satisfy. The short-circuit is also the common case in practice -- every pty:spawn
    // after the worktree's first (new tab, split, reattach) -- and still drives real
    // `ensureRemoteTracksBranchNarrowly` / narrow `fetch` / `--set-upstream-to` git calls.
    await git(['remote', 'add', FORK_REMOTE, forkPath], repoPath)
    const { deps } = depsFor(forkTarget())

    triggerPtySpawnPushTargetMaterialization(deps, {
      cols: 80,
      rows: 24,
      worktreeId
    })

    await vi.waitFor(
      async () => {
        const upstream = await git(
          ['rev-parse', '--abbrev-ref', `${mainBranch}@{u}`],
          repoPath
        ).catch(() => '')
        expect(upstream.trim()).toBe(`${FORK_REMOTE}/${TRACKED_BRANCH}`)
      },
      { timeout: 5000, interval: 25 }
    )

    const remoteUrl = (await git(['remote', 'get-url', FORK_REMOTE], repoPath)).trim()
    expect(remoteUrl).toBe(forkPath)

    // The tracked branch's commit must actually be present -- confirms the narrow fetch ran,
    // not just that the remote config was written.
    const forkHead = (await git(['rev-parse', TRACKED_BRANCH], forkPath)).trim()
    const fetchedHead = (
      await git(['rev-parse', `${FORK_REMOTE}/${TRACKED_BRANCH}`], repoPath)
    ).trim()
    expect(fetchedHead).toBe(forkHead)
  })

  it('is a no-op once the remote was already created (repeat pty:spawn, e.g. reattach)', async () => {
    const target = { ...forkTarget(), remoteCreated: true }
    const { deps } = depsFor(target)
    await git(['remote', 'add', FORK_REMOTE, forkPath], repoPath)

    triggerPtySpawnPushTargetMaterialization(deps, { cols: 80, rows: 24, worktreeId })

    // Give the fire-and-forget chain a tick; there is nothing to wait for since a
    // remoteCreated target must short-circuit before any git call.
    await new Promise((resolve) => setImmediate(resolve))
    const upstream = await git(['rev-parse', '--abbrev-ref', `${mainBranch}@{u}`], repoPath).catch(
      () => ''
    )
    expect(upstream.trim()).toBe('')
  })
})
