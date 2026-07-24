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
