import { describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { MemoryRemoteProvider, jsonLines } from './remote-session-scanner-test-fixtures'

describe('scanRemoteAiVaultSessions OMP subagent partitioning', () => {
  it('excludes remote OMP artifact-dir transcripts and counts them on the parent', async () => {
    const stem = '2026-05-01T10-00-00-000Z_cccccccc-dddd-4eee-8fff-000000000000'
    const workspaceDir = '/home/ada/.omp/agent/sessions/home-app-85dfa2f0'
    const provider = new MemoryRemoteProvider()
    provider.addFile(
      `${workspaceDir}/${stem}.jsonl`,
      jsonLines([
        {
          type: 'session',
          version: 3,
          id: 'cccccccc-dddd-4eee-8fff-000000000000',
          cwd: '/home/ada/repo',
          timestamp: '2026-05-01T10:00:00.000Z'
        },
        {
          type: 'message',
          timestamp: '2026-05-01T10:00:01.000Z',
          message: { role: 'user', content: 'Delegate some tasks' }
        }
      ]),
      70
    )
    for (const label of ['AuthAndPreflight', 'BitbucketDcApi']) {
      provider.addFile(
        `${workspaceDir}/${stem}/${label}.jsonl`,
        jsonLines([
          {
            type: 'message',
            timestamp: '2026-05-01T10:01:00.000Z',
            message: { role: 'user', content: `${label} task prompt` }
          }
        ]),
        71
      )
    }
    // A grandchild belongs to its own parent: neither a row nor a count here.
    provider.addFile(
      `${workspaceDir}/${stem}/AuthAndPreflight/Nested.jsonl`,
      jsonLines([
        {
          type: 'message',
          timestamp: '2026-05-01T10:02:00.000Z',
          message: { role: 'user', content: 'Nested task prompt' }
        }
      ]),
      72
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      agent: 'omp',
      sessionId: 'cccccccc-dddd-4eee-8fff-000000000000',
      subagentTranscriptCount: 2,
      filePath: `${workspaceDir}/${stem}.jsonl`
    })
  })
})
