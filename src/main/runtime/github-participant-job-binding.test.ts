import { runWithGitHubJobRequest } from './github-participant-execution'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { participantRuntimeStore } from './github-participant-store.test-fixture'
import {
  configureStoreGitHubParticipantDevices,
  getStoreGitHubParticipants
} from './github-participant-store'
import { GitHubParticipantJobs } from './github-participant-jobs'
import {
  bindGitHubParticipantSession,
  bindParticipantLaunch
} from './github-participant-job-binding'
import { runWithActiveRpcCaller } from './rpc/callers/active-call'
import type { Repo } from '../../shared/repository/repo-types'
const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('accepted GitHub job launch binding', () => {
  it('captures the accepting member, persists across reload and refuses claimed legacy sessions', async () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-job-binding-'))
    directories.push(path)
    const store = participantRuntimeStore({ getProfileStorageDirectory: () => path })
    configureStoreGitHubParticipantDevices(store, () => ({}))
    const registry = getStoreGitHubParticipants(store)!
    await registry.ready()
    for (const user of ['alice', 'bob']) {
      await registry.createParticipant({
        name: user,
        deviceIds: [user],
        allowedAccounts: [{ host: 'github.com', user }]
      })
    }
    await registry.setRepoEnabled('repo', true)
    for (const user of ['alice', 'bob']) {
      await registry.selectAccount('repo', user, { host: 'github.com', user })
    }
    const repo: Repo = {
      id: 'repo',
      path: '/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1
    }
    await runWithActiveRpcCaller({ kind: 'paired-device', deviceId: 'alice' }, async () => {
      await bindParticipantLaunch(store, { repo, id: 'workspace' }, 'pane', 'launch')
      await bindGitHubParticipantSession(store, 'repo', 'workspace', 'session-new', false)
      await bindGitHubParticipantSession(store, 'repo', 'workspace', 'session-preexisting', true)
    })
    const reopened = new GitHubParticipantJobs(path)
    await reopened.ready()
    expect(reopened.terminal('pane', 'workspace', 'launch')?.account.user).toBe('alice')
    expect(reopened.session('session-new', 'workspace')?.account.user).toBe('alice')
    expect(reopened.session('session-preexisting', 'workspace')).toBeUndefined()
    await expect(
      runWithActiveRpcCaller({ kind: 'paired-device', deviceId: 'bob' }, () =>
        bindGitHubParticipantSession(store, 'repo', 'workspace', 'session-new', true)
      )
    ).rejects.toThrow('github_participant_owner_mismatch')
    await expect(
      runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
        runWithGitHubJobRequest(true, () =>
          bindParticipantLaunch(store, { repo, id: 'workspace' }, 'pane-forged', 'forged')
        )
      )
    ).rejects.toThrow('github_participant_identity_required')
  })
})
