import { describe, expect, it } from 'vitest'
import type { ReadSnapshot } from '../../shared/cloud-workspaces/read-snapshot'
import type { CloudOfflineSnapshot } from '../../shared/hosted-sandbox/cloud-workspace-offline-api'
import { mergeCloudReadSnapshot } from './cloud-offline-snapshot-merge'

const local: CloudOfflineSnapshot = {
  workspaceId: 'w',
  asleep: true,
  capturedAt: 1_000,
  git: {
    branch: 'old',
    head: 'aaa',
    changes: [{ path: 'a.ts', status: 'modified', area: 'unstaged' }],
    changeCount: 1,
    commits: [],
    at: 1_000
  },
  terminals: [{ handle: 'h', title: null, lines: ['x'], at: 1_000 }],
  chats: [
    { sessionId: 's1', at: 1_000, messages: [{ itemId: 'a', role: 'user', text: 'hi', at: 1 }] },
    { sessionId: 's9', at: 900, messages: [{ itemId: 'z', role: 'user', text: 'kept', at: 1 }] }
  ],
  source: 'device'
}

function remote(capturedAt: number): ReadSnapshot {
  return {
    v: 1,
    workspaceId: 'sbx',
    snapshotId: 'snap',
    capturedAt,
    reason: 'sleep',
    git: {
      branch: 'new',
      head: 'bbb',
      changes: [{ path: 'b.ts', status: 'added', area: 'untracked', added: 5, removed: 0 }],
      changeCount: 1,
      added: 5,
      removed: 0,
      commits: []
    },
    pr: {
      number: 7,
      title: 'PR',
      state: 'open',
      url: 'https://github.com/a/b/pull/7',
      checksStatus: 'success',
      checksSummary: null
    },
    sessions: [
      {
        sessionId: 's1',
        agent: 'claude',
        title: 'T',
        status: 'idle',
        turnOutcome: 'done',
        updatedAt: null,
        messages: [{ itemId: 'b', role: 'assistant', text: 'newer', at: 2 }],
        truncated: false
      },
      {
        sessionId: 's2',
        agent: 'codex',
        title: null,
        status: 'working',
        turnOutcome: null,
        updatedAt: null,
        messages: [{ itemId: 'c', role: 'user', text: 'only in cloud', at: 2 }],
        truncated: false
      }
    ]
  }
}

describe('mergeCloudReadSnapshot', () => {
  it('takes newer cloud sections, keeps terminals and chats the snapshot lacks', () => {
    const merged = mergeCloudReadSnapshot(local, remote(2_000))
    expect(merged.git).toMatchObject({ branch: 'new', at: 2_000, added: 5 })
    expect(merged.git?.changes[0]).toMatchObject({ path: 'b.ts', added: 5 })
    expect(merged.terminals).toEqual(local.terminals)
    expect(merged.chats.map((chat) => chat.sessionId)).toEqual(['s1', 's2', 's9'])
    expect(merged.chats[0]).toMatchObject({ agent: 'claude', title: 'T' })
    expect(merged.chats[0]!.messages[0]!.text).toBe('newer')
    expect(merged.pr?.number).toBe(7)
    expect(merged.capturedAt).toBe(2_000)
    expect(merged.source).toBe('mixed')
  })

  it('keeps the local copy where it is newer, but adds what only the cloud has', () => {
    const merged = mergeCloudReadSnapshot(local, remote(500))
    expect(merged.git?.branch).toBe('old')
    expect(merged.chats.find((chat) => chat.sessionId === 's1')!.messages[0]!.text).toBe('hi')
    expect(merged.chats.some((chat) => chat.sessionId === 's2')).toBe(true)
    expect(merged.pr?.number).toBe(7)
    expect(merged.capturedAt).toBe(1_000)
  })

  it('fills an empty local cache entirely from the cloud', () => {
    const empty: CloudOfflineSnapshot = {
      workspaceId: 'w',
      asleep: true,
      capturedAt: null,
      git: null,
      terminals: [],
      chats: []
    }
    const merged = mergeCloudReadSnapshot(empty, remote(2_000))
    expect(merged.capturedAt).toBe(2_000)
    expect(merged.source).toBe('cloud')
    expect(merged.git?.branch).toBe('new')
    expect(merged.chats).toHaveLength(2)
  })
})
