import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../shared/dashboard-snapshot'
import { isDashboardSnapshot } from './dashboard-payload-validation'

const card: DashboardCard = {
  paneKey: 'synthetic:leaf',
  ptyId: null,
  agentType: 'codex',
  bucket: 'done',
  dotState: 'done',
  task: 'Synthetic canceled turn',
  repoId: 'synthetic',
  worktreeId: 'folder',
  tabId: 'tab',
  leafId: null,
  repoName: 'Synthetic project',
  worktreeName: 'Synthetic folder',
  startedAt: 100,
  finishedAt: 200,
  stateChangedAt: 200,
  unseen: true,
  hostKind: 'ssh',
  executionHostId: 'ssh:synthetic',
  workspaceKind: 'folder'
}

describe('dashboard optional interrupted wire field', () => {
  it.each([true, false, undefined])(
    'accepts optional boolean %s on stable done base across JSON transport',
    (interrupted) => {
      const payload = JSON.parse(
        JSON.stringify({
          generatedAt: 300,
          cards: [{ ...card, interrupted }],
          futureOptionalField: true
        })
      )
      expect(isDashboardSnapshot(payload)).toBe(true)
      expect(payload.cards[0].dotState).toBe('done')
      expect(payload.cards[0].interrupted).toBe(interrupted)
    }
  )
  it.each(['true', 1, null, {}, []])('rejects malformed discriminator %j', (interrupted) => {
    expect(isDashboardSnapshot({ generatedAt: 300, cards: [{ ...card, interrupted }] })).toBe(false)
  })
  it.each(['working', 'waiting', 'blocked', 'idle'])(
    'rejects true interruption on nonterminal %s',
    (dotState) => {
      expect(
        isDashboardSnapshot({ generatedAt: 300, cards: [{ ...card, dotState, interrupted: true }] })
      ).toBe(false)
      expect(
        isDashboardSnapshot({
          generatedAt: 300,
          cards: [{ ...card, dotState, interrupted: false }]
        })
      ).toBe(true)
    }
  )
})
