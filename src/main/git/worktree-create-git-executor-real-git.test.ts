import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { gitExecFileAsync } from './runner'
import { addWorktree, listWorktrees } from './worktree'
import { finalizePreparedWorktree } from './worktree-create-preparation'
import { worktreeCreateGit } from './worktree-create-git-executor'
import {
  _resetPreparationPoolForTests,
  listPreparations,
  startPreparation,
  takePreparation
} from '../worktree-create-preparation-pool'
import {
  acquireGitAdmission,
  GitAdmissionScheduler,
  _resetGitAdmissionForTests,
  type GitAdmissionEvent
} from './command-runner/git-subprocess-admission'

const roots: string[] = []
afterEach(async () => {
  _resetGitAdmissionForTests()
  await _resetPreparationPoolForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('creates cold and prepared worktrees with real Git while status capacity is occupied', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-create-policy-'))
  roots.push(root)
  const repo = join(root, 'repo')
  await gitExecFileAsync(['init', '--quiet', repo], { cwd: root })
  await gitExecFileAsync(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo })
  await writeFile(join(repo, 'file.txt'), 'workspace content\n')
  await gitExecFileAsync(['add', '.'], { cwd: repo })
  await gitExecFileAsync(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'],
    { cwd: repo }
  )

  const events: GitAdmissionEvent[] = []
  _resetGitAdmissionForTests(
    new GitAdmissionScheduler({
      generalCap: 1,
      generalHeadroom: 1,
      onAdmissionEvent: (event) => {
        if (event.phase === 'grant') {
          events.push(event)
        }
      }
    })
  )
  await worktreeCreateGit.run(() =>
    startPreparation({
      repoPath: repo,
      workspaceRoot: root,
      baseBranch: 'main',
      canonicalBase: 'refs/heads/main',
      options: {},
      reason: 'prefetch'
    })
  )
  expect(events.length).toBeGreaterThan(0)
  expect(events.every((event) => event.tier === 'status')).toBe(true)
  const [prepared] = listPreparations()
  expect(prepared).toBeDefined()
  takePreparation(prepared)

  const blocker = await acquireGitAdmission({ args: ['status'], cwd: repo })
  events.length = 0
  try {
    await worktreeCreateGit.run(async () => {
      await gitExecFileAsync(['fetch', repo, 'main'], {
        cwd: repo,
        useConfiguredSshCommandForNetwork: true,
        env: { ...process.env, GIT_SSH_COMMAND: '' }
      })
      await addWorktree(repo, join(root, 'cold'), 'cold', 'main')
      await finalizePreparedWorktree(
        repo,
        prepared.preparedPath,
        join(root, 'warm'),
        'warm',
        'main'
      )
      expect(await listWorktrees(repo)).toHaveLength(3)
    })
    expect(events.some((event) => event.args.includes('core.sshCommand'))).toBe(true)
    expect(events.some((event) => event.args.includes('fetch'))).toBe(true)
    expect(events.every((event) => event.tier === 'interactive')).toBe(true)
    expect(
      events
        .filter((event) => event.admissionClass === 'general')
        .every((event) => event.slotKind === 'headroom')
    ).toBe(true)
    for (const name of ['cold', 'warm']) {
      expect(await readFile(join(root, name, 'file.txt'), 'utf8')).toBe('workspace content\n')
    }
  } finally {
    blocker.release()
  }
})
