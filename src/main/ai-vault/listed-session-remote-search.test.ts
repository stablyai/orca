import { describe, expect, it } from 'vitest'
import { createAiVaultTestSession } from '../../shared/ai-vault-session-test-session'
import {
  matchListedSessionsByCardMetadata,
  partitionListedSearchSessions
} from './listed-session-remote-search'

describe('partitionListedSearchSessions', () => {
  it('keeps local ids for desktop rg and isolates SSH/runtime sessions', () => {
    const local = createAiVaultTestSession({ id: 'claude:local', executionHostId: 'local' })
    const ssh = createAiVaultTestSession({
      id: 'claude:ssh',
      executionHostId: 'ssh:dev-box',
      filePath: '/home/ada/.claude/projects/remote.jsonl'
    })
    const runtime = createAiVaultTestSession({
      id: 'claude:runtime',
      executionHostId: 'runtime:env-1'
    })
    const sessionsById = new Map([
      [local.id, local],
      [ssh.id, ssh],
      [runtime.id, runtime]
    ])

    expect(
      partitionListedSearchSessions([local.id, ssh.id, runtime.id, 'claude:unknown'], sessionsById)
    ).toEqual({
      localIds: [local.id, 'claude:unknown'],
      remoteSessions: [ssh, runtime]
    })
  })
})

describe('matchListedSessionsByCardMetadata', () => {
  it('matches remote sessions from title and preview, not a missing local path', () => {
    const hit = createAiVaultTestSession({
      id: 'claude:ssh-hit',
      executionHostId: 'ssh:dev-box',
      title: 'Pairing notes from the build box',
      filePath: '/home/ada/.claude/projects/missing-locally.jsonl',
      previewMessages: [{ role: 'user', text: 'fix the pairing flow', timestamp: null }]
    })
    const miss = createAiVaultTestSession({
      id: 'claude:ssh-miss',
      executionHostId: 'ssh:dev-box',
      title: 'Unrelated compile error',
      filePath: '/home/ada/.claude/projects/other.jsonl',
      previewMessages: [{ role: 'user', text: 'look at the linker', timestamp: null }]
    })

    expect(matchListedSessionsByCardMetadata([hit, miss], 'pairing')).toEqual(['claude:ssh-hit'])
  })
})
