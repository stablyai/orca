// Real-binary coverage for #32864: `git remote -v` appends a partial clone's object
// filter after the direction marker (`<url> (fetch) [blob:none]`). The row parser in
// `git-remote-url-index.ts` used to require the marker at end-of-line, so every fetch
// row of such a remote was dropped: `findRemoteForUrl` saw no remotes and
// `prepareWorktreePushTargetWithExec` minted a duplicate fork remote (`<name>-2`)
// instead of reusing the existing one. The mocked-exec suites cannot catch this --
// they feed hand-written rows, and only a real Git binary emits the annotation.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GitPushTarget } from '../../shared/worktree/types'
import { parseGitRemoteFetchUrls } from '../../shared/git-remote-url-index'
import type { GitRemoteExec } from './worktree-push-target-cleanup'
import { prepareWorktreePushTargetWithExec } from './worktree-push-target-setup'

const execFileAsync = promisify(execFile)

const FORK_REMOTE = 'pr-contributor'
const TRACKED_BRANCH = 'contributor/fix'

let scratchDir = ''
let repoPath = ''
let forkPath = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

const execGit: GitRemoteExec = (args, cwd) => execFileAsync('git', args, { cwd })

async function setIdentity(cwd: string): Promise<void> {
  await git(['config', 'user.name', 'Orca Test'], cwd)
  await git(['config', 'user.email', 'orca@example.test'], cwd)
  await git(['config', 'commit.gpgSign', 'false'], cwd)
  await git(['config', 'core.hooksPath', '.git/no-hooks'], cwd)
}

async function remoteNames(): Promise<string[]> {
  return (await git(['remote'], repoPath)).split(/\r?\n/).filter(Boolean)
}

// `git remote -v` started appending the object filter after the direction marker in
// Git 2.37 (ef6d15ca53). The 2.25 core-workflow baseline predates it, so the
// annotation assertion is version-gated; the annotation parsing itself is covered
// by the mocked rows in git-remote-url-index.test.ts on every version.
async function gitMajorMinor(): Promise<[number, number]> {
  const match = /git version (\d+)\.(\d+)/.exec(await git(['--version'], repoPath))
  return match ? [Number(match[1]), Number(match[2])] : [0, 0]
}

beforeEach(async () => {
  // realpath: macOS hands out /var/... temp paths while Git reports /private/var/...
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-partial-clone-')))
  repoPath = join(scratchDir, 'repo')
  forkPath = join(scratchDir, 'fork')
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q'], repoPath)
  await setIdentity(repoPath)
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'], repoPath)
  await git(['commit', '-qm', 'seed'], repoPath)

  await git(['clone', '-q', repoPath, forkPath], scratchDir)
  await setIdentity(forkPath)
  await git(['checkout', '-qb', TRACKED_BRANCH], forkPath)
  await writeFile(join(forkPath, 'fix.txt'), 'x\n')
  await git(['add', '-A'], forkPath)
  await git(['commit', '-qm', TRACKED_BRANCH], forkPath)

  // The contributor's fork is already registered as a partial-clone remote -- the
  // shape `git clone --filter` (or a hand-configured promisor remote) leaves behind.
  // Only the filter config is needed for Git to annotate the fetch row.
  await git(['remote', 'add', FORK_REMOTE, forkPath], repoPath)
  await git(['config', `remote.${FORK_REMOTE}.partialclonefilter`, 'blob:none'], repoPath)
})

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true })
})

describe('a pre-existing partial-clone fork remote (#32864)', () => {
  it('is parsed out of real `git remote -v` output despite the filter annotation', async () => {
    const stdout = await git(['remote', '-v'], repoPath)
    const [major, minor] = await gitMajorMinor()
    if (major > 2 || (major === 2 && minor >= 37)) {
      // Guard the premise: this Git really does annotate the fetch row.
      expect(stdout).toContain(`(fetch) [blob:none]`)
    }
    expect([...parseGitRemoteFetchUrls(stdout)]).toEqual([[FORK_REMOTE, forkPath]])
  })

  it('is reused instead of duplicated when preparing the push target', async () => {
    const target: GitPushTarget = {
      remoteName: FORK_REMOTE,
      branchName: TRACKED_BRANCH,
      remoteUrl: forkPath
    }

    const prepared = await prepareWorktreePushTargetWithExec(execGit, repoPath, target, () => false)

    expect(prepared.remoteName).toBe(FORK_REMOTE)
    // No `<name>-2` mint: on Git >= 2.37 the annotated fetch row used to be dropped,
    // the existing remote looked absent, and a second remote with the same URL
    // appeared here. Older Git emits no annotation, so this is the reuse path as-is.
    expect(await remoteNames()).toEqual([FORK_REMOTE])
    // Reuse, not mint: Orca's provenance marker is not written onto the pre-existing remote.
    await expect(
      git(['config', '--get', `remote.${FORK_REMOTE}.orca-created`], repoPath)
    ).rejects.toThrow()
    // The reused remote is still narrowed to the requested branch, as for any reuse.
    const refspecs = (await git(['config', '--get-all', `remote.${FORK_REMOTE}.fetch`], repoPath))
      .split(/\r?\n/)
      .filter(Boolean)
    expect(refspecs).toEqual([
      `+refs/heads/${TRACKED_BRANCH}*:refs/remotes/${FORK_REMOTE}/${TRACKED_BRANCH}*`
    ])
  })
})
