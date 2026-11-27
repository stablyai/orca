import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { removeRuntimeRegisteredLocalWorktree } from '../runtime/workspaces/removal/runtime-registered-local-worktree-removal'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import { composeWorktreeId } from '../../shared/worktree/id'
import type { Repo } from '../../shared/repository/repo-types'
import {
  loadWorktreeArchiveHooksForRemoval,
  readWorktreeArchiveHooks
} from './worktree-archive-source'

let fixture: string
let checkout: string
let repo: Repo

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', `core.hooksPath=${join(fixture, 'no-hooks')}`, '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(fixture, 'no-config'),
        GIT_CONFIG_COUNT: '0'
      },
      stdio: 'pipe'
    }
  )
}

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'orca-archive-source-'))
  const seed = join(fixture, 'seed')
  checkout = join(fixture, 'checkout')
  repo = {
    id: 'archive-fixture',
    path: join(fixture, 'bare.git'),
    displayName: 'fixture',
    badgeColor: '',
    addedAt: 0
  }
  await mkdir(seed)
  await mkdir(join(fixture, 'no-hooks'))
  git(seed, 'init', '-q', '-b', 'development')
  await writeFile(join(seed, 'orca.yaml'), 'scripts:\n  archive: shared-command\n')
  git(seed, 'add', 'orca.yaml')
  git(
    seed,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture'
  )
  git(fixture, 'clone', '--bare', seed, repo.path)
  git(repo.path, 'worktree', 'add', checkout, 'development')
})

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true })
})

it('refuses legacy runtime deletion before teardown even with force or hook skip', async () => {
  const refuseTeardown = (): never => {
    throw new Error('Unexpected teardown')
  }
  for (const runHooks of [true, false]) {
    await expect(
      removeRuntimeRegisteredLocalWorktree({
        repo,
        target: { id: composeWorktreeId(repo.id, checkout), repoId: repo.id, path: checkout },
        registeredWorktree: {
          path: checkout,
          branch: 'refs/heads/development',
          head: '',
          isMainWorktree: false,
          isBare: false
        },
        removedPushTarget: undefined,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refusal must precede every store access.
        store: {} as RuntimeStore,
        localOptions: {},
        hasLocalOptions: false,
        force: true,
        runHooks,
        allowFailedArchiveHook: true,
        allowUnverifiedPtyStop: true,
        deleteBranch: false,
        acquireWatcherRemoval: refuseTeardown,
        stopPtys: refuseTeardown,
        closeWatchers: refuseTeardown,
        preserveBranchHead: refuseTeardown,
        finishRemoval: refuseTeardown,
        onRemoved: refuseTeardown,
        publish: refuseTeardown
      })
    ).rejects.toThrow('Archive approval required')
    expect((await readWorktreeArchiveHooks(repo, checkout)).hooks?.scripts.archive).toBe(
      'shared-command'
    )
  }
})

it('requires checkout approval and rejects content changes after approval', async () => {
  const approved = await readWorktreeArchiveHooks(repo, checkout)
  expect(approved.hooks?.scripts.archive).toBe('shared-command')
  await expect(loadWorktreeArchiveHooksForRemoval(repo, checkout)).rejects.toThrow(
    'Archive approval required'
  )
  expect(
    (await loadWorktreeArchiveHooksForRemoval(repo, checkout, approved.approvalHash))?.scripts
      .archive
  ).toBe('shared-command')
  await writeFile(join(checkout, 'orca.yaml'), 'scripts:\n  archive: changed-command\n')
  await expect(
    loadWorktreeArchiveHooksForRemoval(repo, checkout, approved.approvalHash)
  ).rejects.toThrow('Archive approval required')
})

it('pins an empty decision and the selected source, retaining root precedence', async () => {
  await writeFile(join(repo.path, 'orca.yaml'), '{}\n')
  const empty = await readWorktreeArchiveHooks(repo, checkout)
  expect(empty.hooks).toBeNull()
  await rm(join(repo.path, 'orca.yaml'))
  await expect(
    loadWorktreeArchiveHooksForRemoval(repo, checkout, empty.approvalHash)
  ).rejects.toThrow('Archive approval required')
  await writeFile(join(repo.path, 'orca.yaml'), 'scripts:\n  archive: root-command\n')
  expect((await loadWorktreeArchiveHooksForRemoval(repo, checkout))?.scripts.archive).toBe(
    'root-command'
  )
})

it('does not turn malformed or unreadable root configuration into fallback', async () => {
  const rootYaml = join(repo.path, 'orca.yaml')
  await writeFile(rootYaml, 'scripts: [unterminated')
  await expect(readWorktreeArchiveHooks(repo, checkout)).rejects.toThrow(
    'Cannot parse orca.yaml safely'
  )
  await rm(rootYaml)
  await mkdir(rootYaml)
  await expect(readWorktreeArchiveHooks(repo, checkout)).rejects.toThrow()
  await rm(rootYaml, { recursive: true })
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await writeFile(rootYaml, 'scripts:\n  archive: root-command\n')
    await chmod(rootYaml, 0)
    try {
      await expect(readWorktreeArchiveHooks(repo, checkout)).rejects.toThrow()
    } finally {
      await chmod(rootYaml, 0o600)
    }
  }
})

it('rejects a checkout belonging to another repository', async () => {
  const other = join(fixture, 'other.git')
  git(fixture, 'clone', '--bare', join(fixture, 'seed'), other)
  await expect(readWorktreeArchiveHooks({ ...repo, path: other }, checkout)).rejects.toThrow(
    'Cannot verify the checkout owner'
  )
})

it('respects local-only and pins the effective shared-plus-local command', async () => {
  repo.hookSettings = {
    mode: 'auto',
    scripts: { setup: '', archive: 'local-command' },
    commandSourcePolicy: 'local-only'
  }
  expect((await loadWorktreeArchiveHooksForRemoval(repo, checkout))?.scripts.archive).toBe(
    'local-command'
  )
  repo.hookSettings.commandSourcePolicy = 'run-both'
  const approved = await readWorktreeArchiveHooks(repo, checkout)
  expect(approved.hooks?.scripts.archive).toBe('shared-command\nlocal-command')
  repo.hookSettings.scripts.archive = 'different-local-command'
  await expect(
    loadWorktreeArchiveHooksForRemoval(repo, checkout, approved.approvalHash)
  ).rejects.toThrow('Archive approval required')
})
