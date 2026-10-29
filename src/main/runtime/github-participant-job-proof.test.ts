import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { GitHubParticipantRegistry } from './github-participant-registry'
import { GitHubParticipantJobs } from './github-participant-jobs'
import { resolveGitHubParticipantJobProof } from './github-participant-job-proof'
const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'orca-job-proof-'))
  directories.push(path)
  const registry = new GitHubParticipantRegistry(path, () => ({}))
  const account = { host: 'github.com', user: 'alice' }
  const participant = registry.createParticipant({
    name: 'Alice',
    deviceIds: ['alice'],
    allowedAccounts: [account]
  })
  registry.setRepoEnabled('repo', true)
  registry.selectAccount('repo', 'alice', account)
  const identity = { repoId: 'repo', participantId: participant.id, account }
  const jobs = new GitHubParticipantJobs(path)
  const record = agentSessionRecordFixture()
  jobs.bindSession(record.sessionId, record.location.workspaceId, identity)
  return { path, registry, jobs, identity, record }
}

describe('participant job proof', () => {
  it('replays a persisted session snapshot using the current host lease token', async () => {
    const { path, registry, identity, record } = fixture()
    const deps = {
      registry,
      jobs: new GitHubParticipantJobs(path),
      readSession: async () => record,
      verifyTerminal: () => null
    }
    const evidence = { agentSessionId: record.sessionId, agentSessionSpawnToken: 'spawn-owner' }
    expect(await resolveGitHubParticipantJobProof(deps, { kind: 'local-cli' }, evidence)).toEqual(
      identity
    )
    await expect(
      resolveGitHubParticipantJobProof(
        deps,
        { kind: 'local-cli' },
        { ...evidence, agentSessionSpawnToken: 'forged' }
      )
    ).rejects.toThrow('github_participant_job_proof_invalid')
    expect(
      await resolveGitHubParticipantJobProof(
        deps,
        { kind: 'local-cli' },
        { agentSessionId: record.sessionId }
      )
    ).toBeUndefined()
    expect(
      await resolveGitHubParticipantJobProof(
        deps,
        { kind: 'paired-device', deviceId: 'bob' },
        evidence
      )
    ).toBeUndefined()
    registry.updateParticipant(identity.participantId, { allowedAccounts: [] })
    await expect(
      resolveGitHubParticipantJobProof(deps, { kind: 'local-cli' }, evidence)
    ).rejects.toThrow('github_participant_account_not_allowed')
  })

  it('refuses retired and relocated structured owners', async () => {
    const { registry, jobs, record } = fixture()
    const evidence = { agentSessionId: record.sessionId, agentSessionSpawnToken: 'spawn-owner' }
    const deps = { registry, jobs, readSession: async () => record, verifyTerminal: () => null }
    record.lease.unreconciled = true
    await expect(
      resolveGitHubParticipantJobProof(deps, { kind: 'local-cli' }, evidence)
    ).rejects.toThrow('github_participant_job_proof_invalid')
    record.lease.unreconciled = false
    record.location.executionHostId = 'ssh:other'
    await expect(
      resolveGitHubParticipantJobProof(deps, { kind: 'local-cli' }, evidence)
    ).rejects.toThrow('github_participant_job_proof_invalid')
  })

  it('uses terminal proof and an exact stored launch binding, never a workspace claim', async () => {
    const { registry, jobs, identity } = fixture()
    jobs.bindTerminal('pane', 'workspace', 'launch', identity)
    const evidence = { terminalHandle: 'term', paneKey: 'pane', launchToken: 'launch' }
    const deps = {
      registry,
      jobs,
      readSession: async () => null,
      verifyTerminal: () => ({ paneKey: 'pane', workspaceId: 'workspace' })
    }
    expect(await resolveGitHubParticipantJobProof(deps, { kind: 'local-cli' }, evidence)).toEqual(
      identity
    )
    await expect(
      resolveGitHubParticipantJobProof(
        { ...deps, verifyTerminal: () => null },
        { kind: 'local-cli' },
        evidence
      )
    ).rejects.toThrow('github_participant_job_proof_invalid')
    await expect(
      resolveGitHubParticipantJobProof(
        deps,
        { kind: 'local-cli' },
        { ...evidence, launchToken: 'forged' }
      )
    ).resolves.toBeUndefined()
  })
})
