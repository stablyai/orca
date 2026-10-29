import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { partialRuntimeStore } from './runtime-store-partial-fixture'
import {
  configureStoreGitHubParticipantDevices,
  getStoreGitHubParticipants
} from './github-participant-store'
import { GitHubParticipantJobs } from './github-participant-jobs'
import {
  bindGitHubParticipantSession,
  bindParticipantLaunch
} from './github-participant-job-binding'
import { runWithActiveRpcCaller } from './rpc/rpc-active-caller'
import type { Repo } from '../../shared/repo-types'
const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('accepted GitHub job launch binding', () => {
  it('captures the accepting member, persists across reload and refuses claimed legacy sessions', () => {
    const path = mkdtempSync(join(tmpdir(), 'orca-job-binding-'))
    directories.push(path)
    const store = partialRuntimeStore({ getProfileStorageDirectory: () => path })
    configureStoreGitHubParticipantDevices(store, () => ({}))
    const registry = getStoreGitHubParticipants(store)!
    for (const user of ['alice', 'bob']) {
      registry.createParticipant({
        name: user,
        deviceIds: [user],
        allowedAccounts: [{ host: 'github.com', user }]
      })
    }
    registry.setRepoEnabled('repo', true)
    for (const user of ['alice', 'bob']) {
      registry.selectAccount('repo', user, { host: 'github.com', user })
    }
    const repo: Repo = {
      id: 'repo',
      path: '/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1
    }
    runWithActiveRpcCaller({ kind: 'paired-device', deviceId: 'alice' }, () => {
      bindParticipantLaunch(store, { repo, id: 'workspace' }, 'pane', 'launch')
      bindGitHubParticipantSession(store, 'repo', 'workspace', 'session-new', false)
      bindGitHubParticipantSession(store, 'repo', 'workspace', 'session-preexisting', true)
    })
    const reopened = new GitHubParticipantJobs(path)
    expect(reopened.terminal('pane', 'workspace', 'launch')?.account.user).toBe('alice')
    expect(reopened.session('session-new', 'workspace')?.account.user).toBe('alice')
    expect(reopened.session('session-preexisting', 'workspace')).toBeUndefined()
    expect(() =>
      runWithActiveRpcCaller({ kind: 'paired-device', deviceId: 'bob' }, () =>
        bindGitHubParticipantSession(store, 'repo', 'workspace', 'session-new', true)
      )
    ).toThrow('github_participant_owner_mismatch')
    expect(() =>
      runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
        bindParticipantLaunch(store, { repo, id: 'workspace' }, 'pane-forged', 'forged')
      )
    ).toThrow('github_participant_identity_required')
  })
})
