import { describe, expect, it } from 'vitest'
import type { DashboardSnapshot } from '../../shared/dashboard-snapshot'
import { isDashboardRevealAgentArgs, isDashboardSnapshot } from './dashboard-payload-validation'

const SNAPSHOT = {
  generatedAt: 1_700_000_000_000,
  cards: [
    {
      paneKey: 'tab-1:leaf-1',
      ptyId: 'pty-1',
      agentType: 'codex',
      bucket: 'attention',
      dotState: 'waiting',
      task: 'Review the dashboard',
      lastUserMessage: 'Please review this',
      lastAgentMessage: 'I need a decision.',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      repoName: 'Orca',
      worktreeName: 'Dashboard',
      startedAt: 1_699_999_000_000,
      finishedAt: null,
      stateChangedAt: 1_699_999_500_000,
      unseen: true,
      askSummary: '{"question":"Proceed?"}'
    }
  ]
} satisfies DashboardSnapshot

describe('dashboard payload validation', () => {
  it('accepts a complete dashboard snapshot', () => {
    expect(isDashboardSnapshot(SNAPSHOT)).toBe(true)
  })

  it('rejects malformed or unbounded snapshot fields', () => {
    expect(isDashboardSnapshot({ ...SNAPSHOT, generatedAt: Number.NaN })).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], bucket: 'unexpected' }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], lastAgentMessage: 'x'.repeat(8_001) }]
      })
    ).toBe(false)
  })

  it('accepts repo icons a pop-out can safely render, and rejects the rest', () => {
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        repoIconsByRepoId: {
          'repo-1': { type: 'lucide', name: 'Rocket' },
          'repo-2': null,
          'repo-3': {
            type: 'image',
            src: 'https://github.com/anthropics.png?size=64',
            source: 'github'
          }
        }
      })
    ).toBe(true)
    // Absent entirely: a pop-out on older code still gets its snapshot.
    expect(isDashboardSnapshot({ ...SNAPSHOT, repoIconsByRepoId: undefined })).toBe(true)

    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        repoIconsByRepoId: {
          'repo-1': { type: 'image', src: 'javascript:alert(1)', source: 'file' }
        }
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        repoIconsByRepoId: { 'repo-1': { type: 'nonsense' } }
      })
    ).toBe(false)
    expect(isDashboardSnapshot({ ...SNAPSHOT, repoIconsByRepoId: [] })).toBe(false)
  })

  it('bounds the conversation name', () => {
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], conversationName: 'Sparse-checkout parser' }]
      })
    ).toBe(true)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], conversationName: 'x'.repeat(1_025) }]
      })
    ).toBe(false)
  })

  it('requires complete bounded reveal routing', () => {
    expect(
      isDashboardRevealAgentArgs({
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        tabId: 'tab-1',
        leafId: null
      })
    ).toBe(true)
    expect(
      isDashboardRevealAgentArgs({ repoId: 'repo-1', worktreeId: 'worktree-1', tabId: '' })
    ).toBe(false)
  })
})
