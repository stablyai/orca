import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitHubParticipantJobs } from './github-participant-jobs'

const alice = {
  repoId: 'repo',
  participantId: 'alice',
  account: { host: 'github.com', user: 'alice' }
}
const bob = { repoId: 'repo', participantId: 'bob', account: { host: 'github.com', user: 'bob' } }
const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'orca-github-jobs-'))
  directories.push(path)
  return { path, jobs: new GitHubParticipantJobs(path) }
}

describe('durable participant job bindings', () => {
  it('latches malformed storage without rejecting readiness or overwriting the file', async () => {
    const { path, jobs } = fixture()
    await jobs.ready()
    const file = join(path, 'github-participant-jobs.json')
    writeFileSync(file, '{broken')
    const reopened = new GitHubParticipantJobs(path)
    await expect(reopened.ready()).resolves.toBeUndefined()
    expect(() => reopened.session('session', 'workspace')).toThrow(
      'github_participant_jobs_unavailable'
    )
    await expect(reopened.bindSession('session', 'workspace', alice)).rejects.toThrow(
      'github_participant_jobs_unavailable'
    )
    expect(readFileSync(file, 'utf8')).toBe('{broken')
  })

  it('serializes concurrent bindings without losing accepted owners', async () => {
    const { path, jobs } = fixture()
    const results = await Promise.allSettled([
      jobs.bindSession('session', 'workspace', alice),
      jobs.bindSession('session', 'workspace', bob),
      jobs.bindSession('other-session', 'workspace', bob)
    ])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: new Error('github_participant_owner_mismatch')
    })
    const reopened = new GitHubParticipantJobs(path)
    await reopened.ready()
    expect(reopened.session('session', 'workspace')).toEqual(alice)
    expect(reopened.session('other-session', 'workspace')).toEqual(bob)
  })

  it('reloads launch-bound identity without persisting the launch token', async () => {
    const { path, jobs } = fixture()
    await jobs.bindTerminal('pane', 'workspace', 'launch-secret', alice)
    await jobs.bindTerminal('pane', 'workspace', 'launch-secret', {
      ...alice,
      account: bob.account
    })
    await expect(jobs.bindTerminal('pane', 'workspace', 'launch-secret', bob)).rejects.toThrow(
      'github_participant_owner_mismatch'
    )
    const reopened = new GitHubParticipantJobs(path)
    await reopened.ready()
    expect(reopened.terminal('pane', 'workspace', 'launch-secret')).toEqual(alice)
    expect(reopened.terminal('pane', 'workspace', 'other-secret')).toBeUndefined()
    expect(reopened.terminal('pane', 'other-workspace', 'launch-secret')).toBeUndefined()
    expect(readFileSync(join(path, 'github-participant-jobs.json'), 'utf8')).not.toContain(
      'launch-secret'
    )
  })

  it('keeps the accepted session identity and rejects another member claiming the id', async () => {
    const { path, jobs } = fixture()
    await jobs.bindSession('session', 'workspace', alice)
    const reopened = new GitHubParticipantJobs(path)
    await reopened.ready()
    await expect(
      reopened.bindSession('session', 'workspace', { ...alice, account: bob.account })
    ).resolves.toEqual(alice)
    await expect(reopened.bindSession('session', 'workspace', bob)).rejects.toThrow(
      'github_participant_owner_mismatch'
    )
    await expect(reopened.bindSession('session', 'other-workspace', alice)).rejects.toThrow(
      'github_participant_owner_mismatch'
    )
    expect(reopened.session('session', 'workspace')).toEqual(alice)
  })
})
