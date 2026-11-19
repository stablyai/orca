import { describe, expect, it } from 'vitest'
import type { EvalTurnOutcome } from './bot-orchestration-eval-conversation'
import {
  neverSuggestsHandoff,
  onlySuggests,
  suggestsHandoff,
  suggestsNothing
} from './bot-orchestration-eval-look-around-grading'

function turn(ask?: string): EvalTurnOutcome {
  return {
    reply: 'NO_REPLY',
    commands: [],
    shell: [],
    tools: [],
    ownerTools: [],
    writes: ask
      ? [
          {
            method: 'bots.suggest',
            result: { suggested: true },
            params: {
              title: 'Coordinate automation changes',
              why: 'The result card PR needs review.',
              ask
            }
          }
        ]
      : []
  }
}

describe('look-around outcome grading', () => {
  const check = suggestsHandoff({
    bot: 'Ranger',
    include: ['workspace-a', 'workspace-b'],
    forbid: ['owned-workspace'],
    nextStep: /review/
  })

  it('requires a usable request with the bot, workspace IDs, and next step', () => {
    expect(check(turn('Hand workspace-a and workspace-b to Ranger for review.'))).toEqual([])
    for (const wrong of [
      turn(),
      turn('Hand workspace-a to Ranger.'),
      turn('Hand workspace-a and workspace-b to Atlas.'),
      turn('Hand workspace-a, workspace-b and owned-workspace to Ranger.')
    ]) {
      expect(check(wrong).length).toBeGreaterThan(0)
    }
    const vague = turn('Hand workspace-a and workspace-b to Ranger.')
    vague.writes[0]!.params.why = 'These are related.'
    expect(check(vague).length).toBeGreaterThan(0)
    const refused = turn('Hand workspace-a and workspace-b to Ranger for review.')
    refused.writes[0]!.result = undefined
    expect(check(refused).length).toBeGreaterThan(0)
  })

  it('distinguishes an extra takeover from relaying a decision to the existing bot', () => {
    const allowed = turn('Hand workspace-a and workspace-b to Ranger for review.')
    allowed.writes.push({
      method: 'bots.suggest',
      result: { suggested: true },
      params: {
        title: 'Resolve the timezone choice',
        why: 'Shipper needs a decision.',
        ask: 'Help me decide the timezone, then relay my decision to Shipper for owned-workspace.'
      }
    })
    expect(check(allowed)).toEqual([])
    allowed.writes[1]!.params.ask = 'Have Ranger take over owned-workspace.'
    expect(check(allowed).length).toBeGreaterThan(0)
  })

  it('rejects unasked adoption and refused command attempts', () => {
    for (const method of ['worktree.set', 'orchestration.send', 'orchestration.workerStart']) {
      const wrong = turn()
      wrong.writes = [{ method, params: {} }]
      expect(onlySuggests(wrong).length).toBeGreaterThan(0)
    }
    const wrong = turn()
    wrong.commands = [
      ['worktree', 'set', '--worktree', 'workspace-a', '--parent-worktree', 'folder:home']
    ]
    expect(onlySuggests(wrong).length).toBeGreaterThan(0)
    expect(onlySuggests({ ...turn(), reply: 'I will take that over.' }).length).toBeGreaterThan(0)
  })

  it('rejects any suggestion when the scenario expects silence', () => {
    expect(suggestsNothing(turn())).toEqual([])
    expect(suggestsNothing(turn('Hand workspace-a to Ranger.')).length).toBeGreaterThan(0)
  })

  it('rejects a reworded dismissed handoff while allowing unrelated review suggestions', () => {
    const check = neverSuggestsHandoff({ id: 'workspace-a', name: 'result-cards' })
    const review = turn('Review the result-cards PR.')
    review.writes[0]!.params.title = 'Review result cards'
    expect(check(review)).toEqual([])
    expect(check(turn('Let Ranger coordinate workspace-a.')).length).toBeGreaterThan(0)
    expect(check(turn('Hand result-cards over to Ranger.')).length).toBeGreaterThan(0)
  })
})
