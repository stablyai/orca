import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from './git/runner'
import type * as GitRunner from './git/runner'
import {
  _resetLocalWorktreeCreateActivityForTests,
  holdLocalWorktreeCreate
} from './git/local-worktree-create-activity'
import { sweepRetiredWorktreeCreatePreparations } from './retired-worktree-create-preparation-sweep'
import { _resetOwnedSpareIdsForTests, addOwnedSpareId } from './git/worktree-create-spare-ids'
import {
  _resetPendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords
} from './worktree-background-removal'
import { writeWorktreeRemovalRecords } from './worktree-removal-records'

vi.mock('./git/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunner>()
  return { ...actual, gitExecFileAsync: vi.fn(actual.gitExecFileAsync) }
})

const { gitExecFileAsync: actualGitExecFileAsync } =
  await vi.importActual<typeof GitRunner>('./git/runner')
const DEAD_PID = 999_991
const LIVE_PID = 999_992
const roots: string[] = []

afterEach(async () => {
  vi.mocked(gitExecFileAsync).mockImplementation(actualGitExecFileAsync)
  _resetLocalWorktreeCreateActivityForTests()
  _resetOwnedSpareIdsForTests()
  _resetPendingWorktreeRemovalsForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function spareName(pid: number, suffix: string): string {
  return `${pid}-${suffix}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
}

async function makeRoot(): Promise<string> {
  // Git reports resolved paths, and macOS temp dirs sit behind a symlink.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-retired-spares-')))
  roots.push(root)
  return root
}

async function makeRepo(root: string, name: string): Promise<string> {
  const repo = join(root, name)
  await gitExecFileAsync(['init', '--quiet', repo], { cwd: root })
  await gitExecFileAsync(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo })
  await writeFile(join(repo, 'file.txt'), 'content\n')
  await writeFile(join(repo, 'other.txt'), 'other\n')
  await gitExecFileAsync(['add', '.'], { cwd: repo })
  await gitExecFileAsync(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'],
    { cwd: repo }
  )
  return repo
}

async function addSpare(
  repo: string,
  path: string,
  options: { lockPid?: number; noCheckout?: boolean } = {}
): Promise<void> {
  await gitExecFileAsync(
    ['worktree', 'add', '--detach', ...(options.noCheckout ? ['--no-checkout'] : []), path, 'main'],
    { cwd: repo }
  )
  if (options.lockPid !== undefined) {
    await lock(repo, path, `orca-create-preparation:v1:${options.lockPid}:session`)
  }
}

async function lock(repo: string, path: string, reason: string): Promise<void> {
  await gitExecFileAsync(['worktree', 'lock', '--reason', reason, path], { cwd: repo })
}

/** Each registration's lock reason, read from Git's admin files (Git 2.25-2.30 list none). */
async function registrations(repo: string): Promise<Map<string, string>> {
  const adminRoot = join(repo, '.git', 'worktrees')
  const locks = new Map<string, string>([[repo, 'unlocked']])
  for (const name of await readdir(adminRoot).catch(() => [])) {
    const gitFile = (await readFile(join(adminRoot, name, 'gitdir'), 'utf-8')).trim()
    const lock = await readFile(join(adminRoot, name, 'locked'), 'utf-8').catch(() => null)
    locks.set(dirname(gitFile), lock === null ? 'unlocked' : lock.trim())
  }
  return locks
}

const author = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com']

function sweepDeadOwners(workspaceRoot: string, repo: string) {
  return sweepRetiredWorktreeCreatePreparations(
    { workspaceRoots: [workspaceRoot], repos: [{ path: repo }] },
    { isProcessAlive: () => false }
  )
}

function sweepGitCalls(): string[][] {
  return vi.mocked(gitExecFileAsync).mock.calls.map(([args]) => args)
}

it('reclaims spares left by dead Orca processes and leaves everything else alone', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  const spares = join(workspaceRoot, '.orca-preparing')
  const deadSpare = join(spares, spareName(DEAD_PID, '11111111'))
  const liveSpare = join(spares, spareName(LIVE_PID, '22222222'))
  const orphanDirectory = join(spares, spareName(DEAD_PID, '33333333'))
  const userWorktree = join(workspaceRoot, 'feature')
  await addSpare(repo, deadSpare, { lockPid: DEAD_PID })
  await addSpare(repo, liveSpare, { lockPid: LIVE_PID })
  // What a delete Git could not finish leaves: checkout files, no `.git`, no registration.
  await addSpare(repo, orphanDirectory)
  await rm(join(orphanDirectory, '.git'))
  await gitExecFileAsync(['worktree', 'prune'], { cwd: repo })
  await gitExecFileAsync(['worktree', 'add', '-b', 'feature', userWorktree, 'main'], { cwd: repo })

  const result = await sweepRetiredWorktreeCreatePreparations(
    { workspaceRoots: [workspaceRoot], repos: [{ path: repo }] },
    { isProcessAlive: (pid) => pid === LIVE_PID }
  )

  expect(result).toEqual({ reclaimed: 1, removedDirectories: 1 })
  expect(existsSync(deadSpare)).toBe(false)
  expect(existsSync(orphanDirectory)).toBe(false)
  // A running older Orca still owns its spare, so the shared folder stays too.
  expect(existsSync(liveSpare)).toBe(true)
  expect(existsSync(userWorktree)).toBe(true)
  const paths = [...(await registrations(repo)).keys()]
  expect(paths).toContain(liveSpare)
  expect(paths).toContain(userWorktree)
  expect(paths).not.toContain(deadSpare)
})

it('reclaims every shape an older build could leave, in one launch and without a listing', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const droppedRepo = await makeRepo(root, 'dropped-from-orca')
  const workspaceRoot = join(root, 'workspaces')
  const spares = join(workspaceRoot, '.orca-preparing')
  // Quit mid `reset --hard`: no index yet, only some of HEAD's files written.
  const unfinishedSpare = join(spares, spareName(DEAD_PID, '22222222'))
  await addSpare(repo, unfinishedSpare, { noCheckout: true })
  await writeFile(join(unfinishedSpare, 'file.txt'), 'content\n')
  // A spare of a repo the user has since removed from Orca.
  const droppedRepoSpare = join(spares, spareName(DEAD_PID, '33333333'))
  await addSpare(droppedRepo, droppedRepoSpare, { lockPid: DEAD_PID })
  // Quit mid-delete: the directory lost its `.git` file but Git still has it locked.
  const halfDeletedSpare = join(spares, spareName(DEAD_PID, '44444444'))
  await addSpare(repo, halfDeletedSpare, { lockPid: DEAD_PID })
  await rm(join(halfDeletedSpare, '.git'))
  // The directory is gone entirely, or sits in a folder the settings no longer name.
  const vanishedSpare = join(
    root,
    'old-workspaces',
    '.orca-preparing',
    spareName(DEAD_PID, '55555555')
  )
  await addSpare(repo, vanishedSpare, { lockPid: DEAD_PID })
  await rm(vanishedSpare, { recursive: true, force: true })
  // Quit after the spare moved to the user's path, before (or after) `checkout -b`.
  const movedDetached = join(workspaceRoot, 'my-feature')
  await addSpare(repo, movedDetached, { lockPid: DEAD_PID })
  const movedBranched = join(workspaceRoot, 'my-branch')
  await gitExecFileAsync(['worktree', 'add', '-b', 'my-branch', movedBranched, 'main'], {
    cwd: repo
  })
  await lock(repo, movedBranched, `orca-create-preparation:v1:${DEAD_PID}:session`)
  vi.mocked(gitExecFileAsync).mockClear()

  const targets = { workspaceRoots: [workspaceRoot], repos: [{ path: repo }] }
  const dead = { isProcessAlive: () => false }
  const first = await sweepRetiredWorktreeCreatePreparations(targets, dead)

  expect(sweepGitCalls().some((args) => args.includes('list'))).toBe(false)
  expect(first).toEqual({ reclaimed: 6, removedDirectories: 1 })
  for (const path of [unfinishedSpare, droppedRepoSpare, halfDeletedSpare]) {
    expect(existsSync(path)).toBe(false)
  }
  expect(existsSync(spares)).toBe(false)
  const repoRegistrations = await registrations(repo)
  expect([...repoRegistrations.keys()].sort()).toEqual([movedBranched, movedDetached, repo].sort())
  // Moved spares are the user's worktrees now: kept, only no longer hidden.
  expect(repoRegistrations.get(movedDetached)).toBe('unlocked')
  expect(repoRegistrations.get(movedBranched)).toBe('unlocked')
  expect([...(await registrations(droppedRepo)).keys()]).toEqual([droppedRepo])
  vi.mocked(gitExecFileAsync).mockClear()
  expect(await sweepRetiredWorktreeCreatePreparations(targets, dead)).toEqual({
    reclaimed: 0,
    removedDirectories: 0
  })
  expect(sweepGitCalls()).toEqual([])
})

it('keeps anything that may hold the user’s work', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  const spares = join(workspaceRoot, '.orca-preparing')
  // An unlocked spare shows in the sidebar, so the user may have worked in it.
  const editedSpare = join(spares, spareName(DEAD_PID, '11111111'))
  await addSpare(repo, editedSpare)
  await writeFile(join(editedSpare, 'file.txt'), 'user edit\n')
  const unfinishedWithUserFile = join(spares, spareName(DEAD_PID, '22222222'))
  await addSpare(repo, unfinishedWithUserFile, { noCheckout: true })
  await writeFile(join(unfinishedWithUserFile, 'notes.txt'), 'user notes\n')
  const userLockedSpare = join(spares, spareName(DEAD_PID, '33333333'))
  await addSpare(repo, userLockedSpare)
  await lock(repo, userLockedSpare, 'on a USB drive')
  const userDirectory = join(spares, 'notes')
  await mkdir(userDirectory)
  const userWorktree = join(workspaceRoot, 'feature')
  await gitExecFileAsync(['worktree', 'add', '-b', 'feature', userWorktree, 'main'], { cwd: repo })
  await lock(repo, userWorktree, 'on a USB drive')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  const result = await sweepRetiredWorktreeCreatePreparations(
    { workspaceRoots: [workspaceRoot], repos: [{ path: repo }] },
    { isProcessAlive: () => false }
  )

  expect(result).toEqual({ reclaimed: 0, removedDirectories: 0 })
  expect(await readFile(join(editedSpare, 'file.txt'), 'utf-8')).toBe('user edit\n')
  expect(await readFile(join(unfinishedWithUserFile, 'notes.txt'), 'utf-8')).toBe('user notes\n')
  expect(existsSync(userLockedSpare)).toBe(true)
  expect(existsSync(userDirectory)).toBe(true)
  const repoRegistrations = await registrations(repo)
  expect(repoRegistrations.get(editedSpare)).toBe('unlocked')
  expect(repoRegistrations.get(unfinishedWithUserFile)).toBe('unlocked')
  expect(repoRegistrations.get(userLockedSpare)).toBe('on a USB drive')
  expect(repoRegistrations.get(userWorktree)).toBe('on a USB drive')
  warn.mockRestore()
})

it('spawns no Git once nothing is left over', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  await gitExecFileAsync(['worktree', 'add', '-b', 'feature', join(workspaceRoot, 'f'), 'main'], {
    cwd: repo
  })
  vi.mocked(gitExecFileAsync).mockClear()

  const result = await sweepRetiredWorktreeCreatePreparations(
    { workspaceRoots: [workspaceRoot], repos: [{ path: repo }] },
    { isProcessAlive: () => false }
  )

  expect(result).toEqual({ reclaimed: 0, removedDirectories: 0 })
  expect(sweepGitCalls()).toEqual([])
})

it('treats a spare naming this process as an older Orca whose pid was reused', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  const spare = join(workspaceRoot, '.orca-preparing', spareName(process.pid, '11111111'))
  await addSpare(repo, spare, { lockPid: process.pid })

  const result = await sweepRetiredWorktreeCreatePreparations(
    { workspaceRoots: [workspaceRoot], repos: [{ path: repo }] },
    { isProcessAlive: () => true }
  )

  expect(result).toEqual({ reclaimed: 1, removedDirectories: 0 })
  expect(existsSync(spare)).toBe(false)
})

it('never touches a spare this process still owns, its own pid notwithstanding', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  const name = spareName(process.pid, '11111111')
  const spare = join(workspaceRoot, '.orca-preparing', name)
  await addSpare(repo, spare, { lockPid: process.pid })
  addOwnedSpareId(name)

  const result = await sweepRetiredWorktreeCreatePreparations(
    { workspaceRoots: [workspaceRoot], repos: [{ path: repo }] },
    { isProcessAlive: () => true }
  )

  expect(result).toEqual({ reclaimed: 0, removedDirectories: 0 })
  expect(existsSync(spare)).toBe(true)
})

it('skips a spare this process starts owning while the sweep waits on a create', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  const name = spareName(process.pid, '11111111')
  const spare = join(workspaceRoot, '.orca-preparing', name)
  await addSpare(repo, spare, { lockPid: process.pid })
  const release = holdLocalWorktreeCreate()

  const sweep = sweepDeadOwners(workspaceRoot, repo)
  await new Promise((resolve) => setTimeout(resolve, 50))
  addOwnedSpareId(name)
  release()

  expect(await sweep).toEqual({ reclaimed: 0, removedDirectories: 0 })
  expect(existsSync(spare)).toBe(true)
})

it('waits for a local create to finish before reclaiming anything', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  const spare = join(workspaceRoot, '.orca-preparing', spareName(DEAD_PID, '11111111'))
  await addSpare(repo, spare, { lockPid: DEAD_PID })
  const release = holdLocalWorktreeCreate()
  vi.mocked(gitExecFileAsync).mockClear()

  const sweep = sweepRetiredWorktreeCreatePreparations(
    { workspaceRoots: [workspaceRoot], repos: [{ path: repo }] },
    { isProcessAlive: () => false }
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(sweepGitCalls()).toEqual([])
  expect(existsSync(spare)).toBe(true)
  release()

  expect(await sweep).toEqual({ reclaimed: 1, removedDirectories: 0 })
  expect(existsSync(spare)).toBe(false)
})

it('never touches an unlocked spare that was checked out, nor spawns Git for it', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  await writeFile(join(repo, '.git', 'info', 'exclude'), '.env\n')
  const workspaceRoot = join(root, 'workspaces')
  const spares = join(workspaceRoot, '.orca-preparing')
  // Listed in the sidebar, so the user may have committed on its detached HEAD...
  const committedSpare = join(spares, spareName(DEAD_PID, '11111111'))
  await addSpare(repo, committedSpare)
  await writeFile(join(committedSpare, 'work.txt'), 'user work\n')
  await gitExecFileAsync(['add', 'work.txt'], { cwd: committedSpare })
  await gitExecFileAsync([...author, 'commit', '-qm', 'user commit'], { cwd: committedSpare })
  const { stdout: userCommit } = await gitExecFileAsync(['rev-parse', 'HEAD'], {
    cwd: committedSpare
  })
  // ...or kept ignored files there, which Git's clean check does not see.
  const ignoredFileSpare = join(spares, spareName(DEAD_PID, '22222222'))
  await addSpare(repo, ignoredFileSpare)
  await writeFile(join(ignoredFileSpare, '.env'), 'SECRET=1\n')
  vi.mocked(gitExecFileAsync).mockClear()

  expect(await sweepDeadOwners(workspaceRoot, repo)).toEqual({
    reclaimed: 0,
    removedDirectories: 0
  })

  expect(sweepGitCalls()).toEqual([])
  const { stdout: head } = await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: committedSpare })
  expect(head).toBe(userCommit)
  expect(await readFile(join(ignoredFileSpare, '.env'), 'utf-8')).toBe('SECRET=1\n')
  const repoRegistrations = await registrations(repo)
  expect(repoRegistrations.get(committedSpare)).toBe('unlocked')
  expect(repoRegistrations.get(ignoredFileSpare)).toBe('unlocked')
})

it('keeps a never-checked-out spare holding files the user’s config hides from status', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  await gitExecFileAsync(['config', 'status.showUntrackedFiles', 'no'], { cwd: repo })
  await writeFile(join(repo, '.git', 'info', 'exclude'), '.env\n')
  const workspaceRoot = join(root, 'workspaces')
  const spares = join(workspaceRoot, '.orca-preparing')
  const untrackedFileSpare = join(spares, spareName(DEAD_PID, '11111111'))
  await addSpare(repo, untrackedFileSpare, { noCheckout: true })
  await writeFile(join(untrackedFileSpare, 'notes.md'), 'user notes\n')
  const ignoredFileSpare = join(spares, spareName(DEAD_PID, '22222222'))
  await addSpare(repo, ignoredFileSpare, { noCheckout: true })
  await writeFile(join(ignoredFileSpare, '.env'), 'SECRET=1\n')

  expect(await sweepDeadOwners(workspaceRoot, repo)).toEqual({
    reclaimed: 0,
    removedDirectories: 0
  })

  expect(await readFile(join(untrackedFileSpare, 'notes.md'), 'utf-8')).toBe('user notes\n')
  expect(await readFile(join(ignoredFileSpare, '.env'), 'utf-8')).toBe('SECRET=1\n')
})

it('keeps a checked-out spare Git pruned, and one whose repo moved away', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const movedRepo = await makeRepo(root, 'moved')
  const workspaceRoot = join(root, 'workspaces')
  const spares = join(workspaceRoot, '.orca-preparing')
  const prunedSpare = join(spares, spareName(DEAD_PID, '11111111'))
  await addSpare(repo, prunedSpare)
  await writeFile(join(prunedSpare, 'notes.md'), 'user notes\n')
  await rm(join(repo, '.git', 'worktrees', spareName(DEAD_PID, '11111111')), { recursive: true })
  const movedRepoSpare = join(spares, spareName(DEAD_PID, '22222222'))
  await addSpare(movedRepo, movedRepoSpare)
  await writeFile(join(movedRepoSpare, 'file.txt'), 'user edit\n')
  await rename(movedRepo, join(root, 'moved-elsewhere'))

  expect(await sweepDeadOwners(workspaceRoot, repo)).toEqual({
    reclaimed: 0,
    removedDirectories: 0
  })

  expect(await readFile(join(prunedSpare, 'notes.md'), 'utf-8')).toBe('user notes\n')
  expect(await readFile(join(movedRepoSpare, 'file.txt'), 'utf-8')).toBe('user edit\n')
})

it('leaves a spare the user was deleting to that delete’s own startup finish', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  const adoptedSpare = join(workspaceRoot, '.orca-preparing', spareName(DEAD_PID, '11111111'))
  await addSpare(repo, adoptedSpare)
  // A quit stopped Git's delete after it removed the checkout's `.git`; the registration stays.
  await rm(join(adoptedSpare, '.git'))
  const profileDirectory = await makeRoot()
  await writeWorktreeRemovalRecords(profileDirectory, () => [
    {
      worktreeId: `repo::${adoptedSpare}`,
      repoId: 'repo',
      repoPath: repo,
      worktreePath: adoptedSpare,
      branch: '',
      head: '',
      deleteBranch: false,
      force: true,
      requestedAt: 1
    }
  ])
  await loadWorktreeRemovalRecords(profileDirectory)

  expect(await sweepDeadOwners(workspaceRoot, repo)).toEqual({
    reclaimed: 0,
    removedDirectories: 0
  })
  expect(existsSync(join(adoptedSpare, 'file.txt'))).toBe(true)
})

it('matches that delete through a symlinked workspace root, where Git records the real path', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const realRoot = join(root, 'real-workspaces')
  const linkedRoot = join(root, 'linked-workspaces')
  await mkdir(realRoot)
  await symlink(realRoot, linkedRoot, 'junction')
  const name = spareName(DEAD_PID, '11111111')
  const linkedSpare = join(linkedRoot, '.orca-preparing', name)
  await addSpare(repo, linkedSpare)
  await rm(join(linkedSpare, '.git'))
  // The record holds the path as Git lists it, which resolves the link.
  const recordedPath = [...(await registrations(repo)).keys()].find((path) => path.endsWith(name))
  const profileDirectory = await makeRoot()
  await writeWorktreeRemovalRecords(profileDirectory, () => [
    {
      worktreeId: `repo::${linkedSpare}`,
      repoId: 'repo',
      repoPath: repo,
      worktreePath: recordedPath ?? '',
      branch: '',
      head: '',
      deleteBranch: false,
      force: true,
      requestedAt: 1
    }
  ])
  await loadWorktreeRemovalRecords(profileDirectory)

  expect(await sweepDeadOwners(linkedRoot, repo)).toEqual({
    reclaimed: 0,
    removedDirectories: 0
  })
  expect(existsSync(join(linkedSpare, 'file.txt'))).toBe(true)
})

it('holds each deletion for a create that starts mid-sweep', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  const spares = join(workspaceRoot, '.orca-preparing')
  const orphanDirectory = join(spares, spareName(DEAD_PID, '11111111'))
  await mkdir(orphanDirectory, { recursive: true })
  const lockedSpare = join(spares, spareName(DEAD_PID, '22222222'))
  await addSpare(repo, lockedSpare, { lockPid: DEAD_PID })
  let release: (() => void) | undefined
  vi.mocked(gitExecFileAsync).mockClear()

  const sweep = sweepRetiredWorktreeCreatePreparations(
    { workspaceRoots: [workspaceRoot], repos: [{ path: repo }] },
    // The user starts a create after the sweep began.
    { isProcessAlive: () => ((release ??= holdLocalWorktreeCreate()), false) }
  )
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(release).toBeDefined()
  expect(existsSync(orphanDirectory)).toBe(true)
  expect(sweepGitCalls()).toEqual([])
  release?.()

  expect(await sweep).toEqual({ reclaimed: 1, removedDirectories: 1 })
  expect(existsSync(orphanDirectory)).toBe(false)
  expect(existsSync(lockedSpare)).toBe(false)
})

it('holds the next deletion for a create that starts while one is running', async () => {
  const root = await makeRoot()
  const repo = await makeRepo(root, 'repo')
  const workspaceRoot = join(root, 'workspaces')
  const spares = [spareName(DEAD_PID, '11111111'), spareName(DEAD_PID, '22222222')].map((name) =>
    join(workspaceRoot, '.orca-preparing', name)
  )
  for (const spare of spares) {
    await addSpare(repo, spare, { lockPid: DEAD_PID })
  }
  let release: (() => void) | undefined
  vi.mocked(gitExecFileAsync).mockClear()
  vi.mocked(gitExecFileAsync).mockImplementation((args, options) => {
    if (args.includes('remove')) {
      release ??= holdLocalWorktreeCreate()
    }
    return actualGitExecFileAsync(args, options)
  })
  const removals = (): number => sweepGitCalls().filter((args) => args.includes('remove')).length

  const sweep = sweepDeadOwners(workspaceRoot, repo)
  await vi.waitFor(() => expect(spares.filter((spare) => !existsSync(spare))).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(removals()).toBe(1)
  release?.()

  expect(await sweep).toEqual({ reclaimed: 2, removedDirectories: 0 })
  expect(removals()).toBe(2)
})
