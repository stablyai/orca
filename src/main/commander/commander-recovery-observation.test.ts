import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session/lifecycle/agent-session-record'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { readRecoveryObservation } from './commander-recovery-observation'

const directories: string[] = []

const worktree = '/local/private-copy'
const id = `repo1::${worktree}`
const location: AgentSessionExecutionLocation = {
  workspaceKind: 'git-worktree',
  workspaceId: id,
  executionHostId: 'local',
  wslDistro: null
}
const turn = {
  state: 'settled' as const,
  prompt: 'Restore the API',
  reply: 'Added coverage',
  at: 123,
  outcome: 'success' as const
}
const record = { sessionId: 'session1', provider: 'codex', location, lastTurn: turn }
const repo = { id: 'repo1', path: worktree, upstream: { owner: 'team', repo: 'service' } }
function setup(path = worktree) {
  const store = { getRepo: () => ({ ...repo, path }) }
  return {
    requireStore: () => store,
    showManagedWorktree: vi.fn(async () => ({
      id: `repo1::${path}`,
      repoId: 'repo1',
      path,
      hostId: 'local' as const
    }))
  }
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('saves portable evidence from the last turn and discards filename and checkout path', async () => {
  const path = await mkdtemp(join(tmpdir(), 'commander-recovery-checkout-'))
  directories.push(path)
  await gitExecFileAsync(['init', '--initial-branch=review/api'], { cwd: path })
  await gitExecFileAsync(
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.org',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'base'
    ],
    { cwd: path }
  )
  const { stdout } = await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: path })
  const head = stdout.trim()
  const localRecord = { ...record, location: { ...location, workspaceId: `repo1::${path}` } }
  const runtime = setup(path)
  expect((await readRecoveryObservation(runtime, localRecord))?.dirty).toBe(false)
  await writeFile(join(path, 'credential-file'), 'contents stay local')
  const observed = await readRecoveryObservation(runtime, localRecord)
  expect(observed).toMatchObject({
    sessionId: 'session1',
    provider: 'codex',
    goal: 'Restore the API',
    progress: 'Added coverage',
    state: 'settled',
    outcome: 'success',
    at: 123,
    head,
    branch: 'review/api',
    dirty: true
  })
  expect(observed?.projectId).toContain('team/service')
  expect(JSON.stringify(observed)).not.toContain(path)
  expect(JSON.stringify(observed)).not.toContain('credential-file')
  expect(JSON.stringify(observed)).not.toContain('contents stay local')
})

it('keeps a started goal when the checkout is unavailable without pairing the preceding reply with it', async () => {
  const runtime = setup()
  runtime.showManagedWorktree.mockRejectedValue(new Error('missing checkout'))
  const observed = await readRecoveryObservation(runtime, {
    ...record,
    provider: 'claude',
    lastTurn: { ...turn, state: 'open', outcome: undefined }
  })
  expect(observed).toMatchObject({
    provider: 'claude',
    goal: 'Restore the API',
    state: 'open',
    head: null,
    branch: null,
    dirty: null
  })
  expect(observed?.progress).not.toContain('Added coverage')
})

it('excludes folder sessions and remote, WSL, and ambiguously local repo registrations', async () => {
  const runtime = setup()
  for (const candidate of [
    { ...location, workspaceKind: 'folder' as const },
    { ...location, executionHostId: 'ssh:host' as const },
    { ...location, wslDistro: 'Ubuntu' }
  ]) {
    expect(await readRecoveryObservation(runtime, { ...record, location: candidate })).toBeNull()
  }
  const mixed = {
    getRepo: () => ({ ...repo, executionHostId: 'local' as const, connectionId: 'ssh-peer' })
  }
  expect(
    await readRecoveryObservation({ ...runtime, requireStore: () => mixed }, record)
  ).toBeNull()
  expect(runtime.showManagedWorktree).not.toHaveBeenCalled()
})
