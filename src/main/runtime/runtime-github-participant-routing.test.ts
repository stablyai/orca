import './rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as GitHubClient from '../github/client'
import type { Repo } from '../../shared/repo-types'
import { GitHubParticipantJobs } from './github-participant-jobs'
import { GitHubParticipantRegistry } from './github-participant-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { partialRuntimeStore } from './runtime-store-partial-fixture'
import { RpcDispatcher } from './rpc/dispatcher'
import { GITHUB_ISSUE_METHODS } from './rpc/methods/github-issue-methods'
import { runWithActiveRpcCaller } from './rpc/rpc-active-caller'

const { createIssueMock } = vi.hoisted(() => ({
  createIssueMock: vi.fn<(...args: unknown[]) => Promise<{ number: number }>>(async () => ({
    number: 1
  }))
}))
vi.mock('../github/client', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubClient>()),
  createIssue: createIssueMock
}))

const directories: string[] = []
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-github-routing-'))
  directories.push(directory)
  const registry = new GitHubParticipantRegistry(directory, () => ({}))
  for (const id of ['alice', 'bob']) {
    registry.createParticipant({
      name: id,
      deviceIds: [id],
      allowedAccounts: [{ host: 'github.com', user: id }]
    })
  }
  registry.setRepoEnabled('repo', true)
  for (const id of ['alice', 'bob']) {
    registry.selectAccount('repo', id, { host: 'github.com', user: id })
  }
  const repo: Repo = {
    id: 'repo',
    path: '/workspace/project',
    displayName: 'Project',
    badgeColor: 'blue',
    addedAt: 1,
    ghAccount: { host: 'github.com', user: 'owner' }
  }
  class Runtime extends OrcaRuntimeService {
    getGitHubParticipantRegistry() {
      return registry
    }
    plainGitOptions() {
      return this.getLocalGitExecutionOptionArgs(repo)
    }
  }
  const runtime = new Runtime(
    partialRuntimeStore({
      getProfileStorageDirectory: () => directory,
      getRepos: () => [repo],
      getRepo: (id) => (id === repo.id ? repo : undefined),
      getProjects: () => [],
      getSettings: () => ({})
    })
  )
  const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_ISSUE_METHODS })
  return { runtime, dispatcher, registry, repo, directory }
}

describe('runtime GitHub participant routing', () => {
  it('routes simultaneous real RPC mutations through each participant account', async () => {
    const { dispatcher, repo } = fixture()
    const responses = await Promise.all(
      ['alice', 'bob'].map((deviceId) =>
        dispatcher.dispatch(
          {
            id: deviceId,
            authToken: 'fixture',
            method: 'github.createIssue',
            params: { repo: 'id:repo', title: deviceId, body: '' }
          },
          { caller: { kind: 'paired-device', deviceId } }
        )
      )
    )
    expect(responses.every((response) => response.ok)).toBe(true)
    expect(createIssueMock).toHaveBeenCalledTimes(2)
    const optionsByTitle = new Map(createIssueMock.mock.calls.map((call) => [call[1], call.at(-1)]))
    expect(optionsByTitle.get('alice')).toMatchObject({
      ghAccount: { host: 'github.com', user: 'alice' }
    })
    expect(optionsByTitle.get('bob')).toMatchObject({
      ghAccount: { host: 'github.com', user: 'bob' }
    })
    expect(repo.ghAccount?.user).toBe('owner')
  })

  it('refuses unknown callers before mutation while plain Git remains usable', async () => {
    const { dispatcher, runtime } = fixture()
    const response = await dispatcher.dispatch(
      {
        id: 'unknown',
        authToken: 'fixture',
        method: 'github.createIssue',
        params: { repo: 'id:repo', title: 'denied', body: '' }
      },
      { caller: { kind: 'paired-device', deviceId: 'unknown' } }
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'github_participant_missing' } })
    expect(createIssueMock).not.toHaveBeenCalled()
    expect(() =>
      runWithActiveRpcCaller({ kind: 'local-cli' }, () => runtime.plainGitOptions())
    ).not.toThrow()
  })

  it('replays host-recorded terminal ownership and ignores job claims from another paired member', async () => {
    const { runtime, dispatcher, registry, directory } = fixture()
    const selected = registry.resolveAccount('repo', 'alice')!
    new GitHubParticipantJobs(directory).bindTerminal('pane', 'workspace', 'launch', {
      repoId: 'repo',
      ...selected
    })
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockReturnValue({
      hostScope: { kind: 'local', hostId: 'local' },
      paneKey: 'pane',
      terminalHandle: 'term',
      processIncarnation: 'process',
      launchTokenHash: 'hash'
    })
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      runtimeId: 'runtime',
      terminalHandle: 'term',
      ptyId: 'pty',
      worktreeId: 'workspace',
      processIncarnation: 'process',
      paneKey: 'pane',
      launchTokenHash: 'hash',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const request = {
      id: 'job',
      authToken: 'fixture',
      method: 'github.createIssue',
      params: { repo: 'id:repo', title: 'job', body: '' },
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term',
        paneKey: 'pane',
        launchToken: 'launch'
      }
    }
    expect(await dispatcher.dispatch(request, { caller: { kind: 'local-cli' } })).toMatchObject({
      ok: true
    })
    expect(createIssueMock.mock.calls.at(-1)?.at(-1)).toMatchObject({ ghAccount: selected.account })
    expect(
      await dispatcher.dispatch(request, { caller: { kind: 'paired-device', deviceId: 'bob' } })
    ).toMatchObject({ ok: true })
    expect(createIssueMock.mock.calls.at(-1)?.at(-1)).toMatchObject({
      ghAccount: { host: 'github.com', user: 'bob' }
    })
    registry.updateParticipant(selected.participantId, { allowedAccounts: [] })
    expect(await dispatcher.dispatch(request, { caller: { kind: 'local-cli' } })).toMatchObject({
      ok: false,
      error: { code: 'github_participant_account_not_allowed' }
    })
    expect(createIssueMock).toHaveBeenCalledTimes(2)
  })

  it('rejects repo-less GitHub operations before ambient execution', async () => {
    const { runtime } = fixture()
    expect(() =>
      runWithActiveRpcCaller({ kind: 'paired-device', deviceId: 'alice' }, () =>
        runtime.getGitHubRateLimit()
      )
    ).toThrow('github_participant_repo_required')
    expect(() =>
      runWithActiveRpcCaller({ kind: 'paired-device', deviceId: 'alice' }, () =>
        runtime.listGitHubProjects()
      )
    ).toThrow('github_participant_repo_required')
  })
})
