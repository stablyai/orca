import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  it('reloads launch-bound identity without persisting the launch token', () => {
    const { path, jobs } = fixture()
    jobs.bindTerminal('pane', 'workspace', 'launch-secret', alice)
    jobs.bindTerminal('pane', 'workspace', 'launch-secret', { ...alice, account: bob.account })
    expect(() => jobs.bindTerminal('pane', 'workspace', 'launch-secret', bob)).toThrow(
      'github_participant_owner_mismatch'
    )
    const reopened = new GitHubParticipantJobs(path)
    expect(reopened.terminal('pane', 'workspace', 'launch-secret')).toEqual(alice)
    expect(reopened.terminal('pane', 'workspace', 'other-secret')).toBeUndefined()
    expect(reopened.terminal('pane', 'other-workspace', 'launch-secret')).toBeUndefined()
    expect(readFileSync(join(path, 'github-participant-jobs.json'), 'utf8')).not.toContain(
      'launch-secret'
    )
  })

  it('keeps the accepted session identity and rejects another member claiming the id', () => {
    const { path, jobs } = fixture()
    jobs.bindSession('session', 'workspace', alice)
    const reopened = new GitHubParticipantJobs(path)
    expect(
      reopened.bindSession('session', 'workspace', { ...alice, account: bob.account })
    ).toEqual(alice)
    expect(() => reopened.bindSession('session', 'workspace', bob)).toThrow(
      'github_participant_owner_mismatch'
    )
    expect(() => reopened.bindSession('session', 'other-workspace', alice)).toThrow(
      'github_participant_owner_mismatch'
    )
    expect(reopened.session('session', 'workspace')).toEqual(alice)
  })
})
