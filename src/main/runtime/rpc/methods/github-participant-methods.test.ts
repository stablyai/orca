import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RpcDispatcher } from '../dispatcher'
import { GITHUB_PARTICIPANT_METHODS } from './github-participant-methods'
import { GITHUB_ACCOUNT_BINDING_METHODS } from './github-account-binding-methods'
import { REPO_METHODS } from './repo'
import { GitHubParticipantRegistry } from '../../github-participant-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { runWithGitHubExecutionIdentity } from '../../github-participant-execution'

const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'orca-participant-rpc-'))
  directories.push(path)
  const account = { host: 'github.com', user: 'alice' }
  const registry = new GitHubParticipantRegistry(path, (id) => (id === 'device-a' ? {} : null))
  registry.createParticipant({ name: 'Alice', deviceIds: ['device-a'], allowedAccounts: [account] })
  registry.setRepoEnabled('repo', true)
  const update = vi.fn()
  const validate = vi.fn(async () => ({ ok: true, binding: account }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These handlers use only the runtime methods supplied by this focused fixture.
  const runtime = {
    getRuntimeId: () => 'test',
    getGitHubParticipantRegistry: () => registry,
    listGitHubParticipantDevices: () => [{ deviceId: 'device-a', name: 'A' }],
    notifyGitHubParticipantAccountsChanged: vi.fn(),
    requireStore: () => ({ getProfileStorageDirectory: () => path }),
    showRepo: async () => ({ id: 'repo', ghAccount: { host: 'github.com', user: 'shared' } }),
    updateRepo: update,
    validateGitHubAccountBinding: validate,
    listGitHubBindableAccounts: async () => ({
      capability: 'supported',
      accounts: ['alice', 'bob'].map((user) => ({
        host: 'github.com',
        user,
        source: 'keyring',
        active: false,
        envToken: null,
        scopes: []
      }))
    })
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [...GITHUB_PARTICIPANT_METHODS, ...GITHUB_ACCOUNT_BINDING_METHODS, ...REPO_METHODS]
  })
  const call = (method: string, params: unknown) =>
    dispatcher.dispatch(
      { id: 'test', authToken: 'fixture', method, params },
      {
        caller: { kind: 'paired-device', deviceId: 'device-a' },
        pairedDeviceId: 'device-a',
        callerScope: { kind: 'runtime-paired', grants: [] }
      }
    )
  const jobCall = (method: string, params: unknown) =>
    runWithGitHubExecutionIdentity(
      {
        repoId: 'repo',
        participantId: registry.listParticipants()[0].id,
        account
      },
      () =>
        dispatcher.dispatch(
          { id: 'job', authToken: 'fixture', method, params },
          {
            caller: { kind: 'local-cli' },
            callerScope: { kind: 'owner' }
          }
        )
    )
  const ownerCall = (evidence?: { agentSessionId?: string; launchToken?: string }) =>
    dispatcher.dispatch(
      {
        id: 'owner',
        authToken: 'fixture',
        method: 'github.participants.setEnabled',
        params: { repo: 'repo', enabled: false },
        ...(evidence ? { orchestrationCompatibilityEvidence: evidence } : {})
      },
      { caller: { kind: 'local-cli' }, callerScope: { kind: 'owner' } }
    )
  return { call, jobCall, ownerCall, registry, update, validate }
}

describe('GitHub participant RPC authority', () => {
  it.each([
    { enabled: true, evidence: { agentSessionId: 'old-session-without-spawn-proof' } },
    { enabled: false, evidence: { agentSessionId: 'old-session-without-spawn-proof' } },
    { enabled: false, evidence: { launchToken: 'old-terminal-without-binding' } }
  ])(
    'does not promote an unbound job to owner with mode $enabled: $evidence',
    async ({ enabled, evidence }) => {
      const { ownerCall, registry } = fixture()
      registry.setRepoEnabled('repo', enabled)
      expect(await ownerCall(evidence)).toMatchObject({
        ok: false,
        error: { code: 'github_participant_owner_required' }
      })
      expect(registry.isRepoEnabled('repo')).toBe(enabled)
      expect((await ownerCall()).ok).toBe(true)
      expect(registry.isRepoEnabled('repo')).toBe(false)
    }
  )
  it('retains member restrictions for a verified job on the local socket', async () => {
    const { jobCall, registry, update, validate } = fixture()
    expect(
      (await jobCall('github.participants.setEnabled', { repo: 'repo', enabled: false })).ok
    ).toBe(false)
    expect(registry.isRepoEnabled('repo')).toBe(true)
    expect(
      (
        await jobCall('repo.update', {
          repo: 'repo',
          updates: { ghAccount: { host: 'github.com', user: 'bob' } }
        })
      ).ok
    ).toBe(false)
    expect(update).not.toHaveBeenCalled()
    expect(await jobCall('github.listBindableAccounts', { repo: 'repo' })).toMatchObject({
      ok: true,
      result: { accounts: [{ user: 'alice' }] }
    })
    expect(
      await jobCall('github.validateAccountBinding', {
        repo: 'repo',
        host: 'github.com',
        user: 'bob'
      })
    ).toMatchObject({ ok: true, result: { ok: false } })
    expect(validate).not.toHaveBeenCalled()
  })
  it('denies participant administration to a paired client before registry changes', async () => {
    const { call, registry } = fixture()
    const response = await call('github.participants.setEnabled', { repo: 'repo', enabled: false })
    expect(response.ok).toBe(false)
    expect(registry.isRepoEnabled('repo')).toBe(true)
  })

  it('blocks legacy paired-client writes to the shared account when member mode is enabled', async () => {
    const { call, update } = fixture()
    const response = await call('repo.update', {
      repo: 'repo',
      updates: { ghAccount: { host: 'github.com', user: 'bob' } }
    })
    expect(response.ok).toBe(false)
    expect(update).not.toHaveBeenCalled()
  })

  it('lists only assigned accounts and refuses probing an unassigned account', async () => {
    const { call, validate } = fixture()
    const listed = await call('github.listBindableAccounts', { repo: 'repo' })
    expect(listed).toMatchObject({ ok: true, result: { accounts: [{ user: 'alice' }] } })
    const result = await call('github.validateAccountBinding', {
      repo: 'repo',
      host: 'github.com',
      user: 'bob'
    })
    expect(result).toMatchObject({ ok: true, result: { ok: false } })
    expect(validate).not.toHaveBeenCalled()
  })

  it('rejects claimed participant identity and resolves self from authenticated device', async () => {
    const { call, registry } = fixture()
    const spoof = await call('github.participants.select', {
      repo: 'repo',
      participantId: 'bob',
      account: { host: 'github.com', user: 'alice' }
    })
    expect(spoof.ok).toBe(false)
    expect(
      (
        await call('github.participants.select', {
          repo: 'repo',
          account: { host: 'github.com', user: 'alice' }
        })
      ).ok
    ).toBe(true)
    expect(registry.resolveAccount('repo', 'device-a')?.account.user).toBe('alice')
  })
})
