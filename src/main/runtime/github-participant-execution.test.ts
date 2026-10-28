import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitHubParticipantRegistry } from './github-participant-registry'
import { runWithActiveRpcCaller } from './rpc/rpc-active-caller'
import {
  assertUnscopedGitHubAccess,
  captureGitHubExecutionIdentity,
  createGitHubExecutionAccountResolver,
  resolveGitHubExecutionAccount,
  runWithGitHubExecutionIdentity
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
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-github-execution-'))
  directories.push(directory)
  const registry = new GitHubParticipantRegistry(directory, () => ({}))
  const alice = registry.createParticipant({
    name: 'Alice',
    deviceIds: ['alice'],
    allowedAccounts: [aliceAccount, bobAccount]
  })
  registry.createParticipant({ name: 'Bob', deviceIds: ['bob'], allowedAccounts: [bobAccount] })
  registry.setRepoEnabled('repo', true)
  registry.selectAccount('repo', 'alice', aliceAccount)
  registry.selectAccount('repo', 'bob', bobAccount)
  return { registry, alice }
}
const asDevice = <T>(deviceId: string, run: () => T) =>
  runWithActiveRpcCaller({ kind: 'paired-device', deviceId }, run)

describe('GitHub participant execution', () => {
  it('isolates concurrent callers without changing the shared binding', async () => {
    const { registry } = fixture()
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

  it('preserves legacy bindings and lets the explicit desktop owner use the shared account', () => {
    const { registry } = fixture()
    expect(
      asDevice('unknown', () => resolveGitHubExecutionAccount(registry, 'legacy', sharedAccount))
    ).toEqual(sharedAccount)
    expect(
      runWithActiveRpcCaller({ kind: 'desktop' }, () =>
        resolveGitHubExecutionAccount(registry, 'repo', sharedAccount)
      )
    ).toEqual(sharedAccount)
    expect(resolveGitHubExecutionAccount(undefined, 'repo', sharedAccount)).toEqual(sharedAccount)
  })

  it('refuses enabled operations without proven membership instead of falling back', () => {
    const { registry } = fixture()
    expect(() =>
      asDevice('unknown', () => resolveGitHubExecutionAccount(registry, 'repo', sharedAccount))
    ).toThrow('github_participant_missing')
    expect(() =>
      runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
        resolveGitHubExecutionAccount(registry, 'repo', sharedAccount)
      )
    ).toThrow('github_participant_identity_required')
    expect(() => resolveGitHubExecutionAccount(registry, 'repo', sharedAccount)).toThrow(
      'github_participant_identity_required'
    )
  })

  it('captures a job account once, checks current grants and rejects another caller or repo', () => {
    const { registry, alice } = fixture()
    const identity = asDevice('alice', () => captureGitHubExecutionIdentity(registry, 'repo'))
    expect(identity).toEqual({ repoId: 'repo', participantId: alice.id, account: aliceAccount })
    registry.selectAccount('repo', 'alice', bobAccount)
    runWithGitHubExecutionIdentity(identity, () => {
      expect(resolveGitHubExecutionAccount(registry, 'repo', sharedAccount)).toEqual(aliceAccount)
      expect(() =>
        asDevice('bob', () => resolveGitHubExecutionAccount(registry, 'repo', sharedAccount))
      ).toThrow('github_participant_owner_mismatch')
      registry.setRepoEnabled('other', true)
      expect(() => resolveGitHubExecutionAccount(registry, 'other', sharedAccount)).toThrow(
        'github_participant_owner_mismatch'
      )
      registry.updateParticipant(alice.id, { allowedAccounts: [bobAccount] })
      expect(() => resolveGitHubExecutionAccount(registry, 'repo', sharedAccount)).toThrow(
        'github_participant_account_not_allowed'
      )
    })
  })

  it('pins lazy hosted-review identity before yielding and revalidates grants at execution', () => {
    const { registry, alice } = fixture()
    const resolve = asDevice('alice', () =>
      createGitHubExecutionAccountResolver(registry, 'repo', sharedAccount)
    )
    registry.selectAccount('repo', 'alice', bobAccount)
    expect(resolve()).toEqual(aliceAccount)
    registry.updateParticipant(alice.id, { allowedAccounts: [bobAccount] })
    expect(resolve).toThrow('github_participant_account_not_allowed')
  })

  it('defers missing identity errors until a generic hosted-review operation uses GitHub', () => {
    const { registry } = fixture()
    const resolve = createGitHubExecutionAccountResolver(registry, 'repo', sharedAccount)
    expect(resolve).toThrow('github_participant_identity_required')
  })

  it('refuses ambient repo-less calls while participant mode is enabled', () => {
    const { registry } = fixture()
    expect(() => asDevice('alice', () => assertUnscopedGitHubAccess(registry))).toThrow(
      'github_participant_repo_required'
    )
    expect(() => assertUnscopedGitHubAccess(registry)).toThrow('github_participant_repo_required')
    expect(() =>
      runWithActiveRpcCaller({ kind: 'desktop' }, () => assertUnscopedGitHubAccess(registry))
    ).not.toThrow()
    registry.setRepoEnabled('repo', false)
    expect(() => asDevice('alice', () => assertUnscopedGitHubAccess(registry))).not.toThrow()
  })
})
