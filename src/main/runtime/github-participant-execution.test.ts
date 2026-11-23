import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitHubParticipantRegistry } from './github-participant-registry'
import { runWithActiveRpcCaller } from './rpc/callers/active-call'
import {
  assertUnscopedGitHubAccess,
  captureGitHubExecutionIdentity,
  createGitHubExecutionAccountResolver,
  resolveGitHubExecutionAccount,
  runWithGitHubExecutionIdentity,
  runWithGitHubJobRequest
} from './github-participant-execution'

const aliceAccount = { host: 'github.com', user: 'alice' }
const bobAccount = { host: 'github.com', user: 'bob' }
const sharedAccount = { host: 'github.com', user: 'server-owner' }
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-github-execution-'))
  directories.push(directory)
  const registry = new GitHubParticipantRegistry(directory, () => ({}))
  const alice = await registry.createParticipant({
    name: 'Alice',
    deviceIds: ['alice'],
    allowedAccounts: [aliceAccount, bobAccount]
  })
  await registry.createParticipant({
    name: 'Bob',
    deviceIds: ['bob'],
    allowedAccounts: [bobAccount]
  })
  await registry.setRepoEnabled('repo', true)
  await registry.selectAccount('repo', 'alice', aliceAccount)
  await registry.selectAccount('repo', 'bob', bobAccount)
  return { registry, alice }
}
const asDevice = <T>(deviceId: string, run: () => T) =>
  runWithActiveRpcCaller({ kind: 'paired-device', deviceId }, run)

describe('GitHub participant execution', () => {
  it('isolates concurrent callers without changing the shared binding', async () => {
    const { registry } = await fixture()
    const results = await Promise.all(
      ['alice', 'bob'].map((id) =>
        asDevice(id, async () => {
          await Promise.resolve()
          return resolveGitHubExecutionAccount(registry, 'repo', sharedAccount)
        })
      )
    )
    expect(results).toEqual([aliceAccount, bobAccount])
    expect(sharedAccount.user).toBe('server-owner')
  })

  it('preserves legacy bindings and lets desktop and owner shell calls use the shared account', async () => {
    const { registry } = await fixture()
    expect(
      asDevice('unknown', () => resolveGitHubExecutionAccount(registry, 'legacy', sharedAccount))
    ).toEqual(sharedAccount)
    expect(
      runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
        resolveGitHubExecutionAccount(registry, 'repo', sharedAccount)
      )
    ).toEqual(sharedAccount)
    expect(
      runWithActiveRpcCaller({ kind: 'desktop' }, () =>
        resolveGitHubExecutionAccount(registry, 'repo', sharedAccount)
      )
    ).toEqual(sharedAccount)
    expect(resolveGitHubExecutionAccount(undefined, 'repo', sharedAccount)).toEqual(sharedAccount)
  })

  it('refuses enabled operations without proven membership instead of falling back', async () => {
    const { registry } = await fixture()
    expect(() =>
      asDevice('unknown', () => resolveGitHubExecutionAccount(registry, 'repo', sharedAccount))
    ).toThrow('github_participant_missing')
    expect(() =>
      runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
        runWithGitHubJobRequest(true, () =>
          resolveGitHubExecutionAccount(registry, 'repo', sharedAccount)
        )
      )
    ).toThrow('github_participant_identity_required')
    expect(() => resolveGitHubExecutionAccount(registry, 'repo', sharedAccount)).toThrow(
      'github_participant_identity_required'
    )
  })

  it('captures a job account once, checks current grants and rejects another caller or repo', async () => {
    const { registry, alice } = await fixture()
    const identity = asDevice('alice', () => captureGitHubExecutionIdentity(registry, 'repo'))
    expect(identity).toEqual({ repoId: 'repo', participantId: alice.id, account: aliceAccount })
    await registry.selectAccount('repo', 'alice', bobAccount)
    await runWithGitHubExecutionIdentity(identity, async () => {
      expect(resolveGitHubExecutionAccount(registry, 'repo', sharedAccount)).toEqual(aliceAccount)
      expect(() =>
        asDevice('bob', () => resolveGitHubExecutionAccount(registry, 'repo', sharedAccount))
      ).toThrow('github_participant_owner_mismatch')
      await registry.setRepoEnabled('other', true)
      expect(() => resolveGitHubExecutionAccount(registry, 'other', sharedAccount)).toThrow(
        'github_participant_owner_mismatch'
      )
      await registry.updateParticipant(alice.id, { allowedAccounts: [bobAccount] })
      expect(() => resolveGitHubExecutionAccount(registry, 'repo', sharedAccount)).toThrow(
        'github_participant_account_not_allowed'
      )
    })
  })

  it('pins lazy hosted-review identity before yielding and revalidates grants at execution', async () => {
    const { registry, alice } = await fixture()
    const resolve = asDevice('alice', () =>
      createGitHubExecutionAccountResolver(registry, 'repo', sharedAccount)
    )
    await registry.selectAccount('repo', 'alice', bobAccount)
    expect(resolve()).toEqual(aliceAccount)
    await registry.updateParticipant(alice.id, { allowedAccounts: [bobAccount] })
    expect(resolve).toThrow('github_participant_account_not_allowed')
  })

  it.each([sharedAccount, undefined])(
    'rejects switching from a shared binding to a participant account mid-operation (%j)',
    async (binding) => {
      const { registry } = await fixture()
      await registry.setRepoEnabled('repo', false)
      const resolve = asDevice('alice', () =>
        createGitHubExecutionAccountResolver(registry, 'repo', binding)
      )
      expect(resolve()).toEqual(binding)
      await registry.setRepoEnabled('repo', true)
      await registry.selectAccount('repo', 'alice', aliceAccount)
      expect(resolve).toThrow('github_participant_account_changed')
    }
  )

  it('defers missing identity errors until a generic hosted-review operation uses GitHub', async () => {
    const { registry } = await fixture()
    const resolve = createGitHubExecutionAccountResolver(registry, 'repo', sharedAccount)
    expect(resolve).toThrow('github_participant_identity_required')
  })

  it('retains an unbound job context when a deferred resolver leaves the request', async () => {
    const { registry } = await fixture()
    await registry.setRepoEnabled('repo', false)
    const resolve = runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
      runWithGitHubJobRequest(true, () =>
        createGitHubExecutionAccountResolver(registry, 'repo', sharedAccount)
      )
    )
    await registry.setRepoEnabled('repo', true)
    expect(resolve).toThrow('github_participant_identity_required')
  })

  it('refuses ambient repo-less calls while participant mode is enabled', async () => {
    const { registry } = await fixture()
    expect(() => asDevice('alice', () => assertUnscopedGitHubAccess(registry))).toThrow(
      'github_participant_repo_required'
    )
    expect(() => assertUnscopedGitHubAccess(registry)).toThrow('github_participant_repo_required')
    expect(() =>
      runWithActiveRpcCaller({ kind: 'desktop' }, () => assertUnscopedGitHubAccess(registry))
    ).not.toThrow()
    expect(() =>
      runWithActiveRpcCaller({ kind: 'local-cli' }, () => assertUnscopedGitHubAccess(registry))
    ).not.toThrow()
    expect(() =>
      runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
        runWithGitHubJobRequest(true, () => assertUnscopedGitHubAccess(registry))
      )
    ).toThrow('github_participant_repo_required')
    await registry.setRepoEnabled('repo', false)
    expect(() => asDevice('alice', () => assertUnscopedGitHubAccess(registry))).not.toThrow()
  })
})
