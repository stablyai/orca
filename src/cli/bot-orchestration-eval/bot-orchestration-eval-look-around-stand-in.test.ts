import { describe, expect, it } from 'vitest'
import { EMPTY_BOT_LOOK } from '../../main/bots/bot-look-around-state'
import { EVAL_BOT, type EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'
import { serveOrchestration } from './bot-orchestration-eval-orca'

function host(): EvalHostState {
  return {
    bots: [{ ...EVAL_BOT, agent: 'codex' }],
    automations: [],
    repos: [],
    timezone: 'UTC',
    lookAround: structuredClone(EMPTY_BOT_LOOK)
  }
}

const params = {
  callerSessionId: 'look-1',
  title: 'Coordinate the automation review',
  why: 'The result cards are ready for review.',
  ask: 'Hand the automation workspace to Ranger.'
}

describe('look-around eval stand-in', () => {
  it('stores a real suggestion, returns the CLI receipt, and rejects a duplicate', () => {
    const state = host()
    const log: Record<string, unknown>[] = []
    let saved: EvalHostState | undefined
    const io = {
      record: (entry: Record<string, unknown>) => log.push(entry),
      save: (next: EvalHostState) => {
        saved = next
      }
    }
    expect(serveOrchestration(state, 'bots.suggest', params, io)).toMatchObject({
      suggestion: { title: params.title }
    })
    expect(saved?.lookAround?.suggestions).toMatchObject([
      {
        title: params.title,
        why: params.why,
        ask: params.ask,
        status: 'open',
        runSessionId: 'look-1'
      }
    ])
    expect(log[0]).toMatchObject({ method: 'bots.suggest', result: { suggested: true } })
    expect(() => serveOrchestration(state, 'bots.suggest', params, io)).toThrow('Already suggested')
    expect(state.lookAround?.suggestions).toHaveLength(1)
    expect(log[1]).not.toHaveProperty('result')
  })

  it('refuses suggestions outside a look and after its run ended', () => {
    const state = host()
    const io = { record: () => {}, save: () => {} }
    delete state.lookAround
    expect(() => serveOrchestration(state, 'bots.suggest', params, io)).toThrow(
      'Only a look-around'
    )
    state.lookAround = {
      ...EMPTY_BOT_LOOK,
      runs: [{ sessionId: 'look-1', startedAt: 0, endedAt: 1 }]
    }
    expect(() => serveOrchestration(state, 'bots.suggest', params, io)).toThrow(
      'Only a look-around'
    )
  })
})
