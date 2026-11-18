// The automation graders on traces built by hand: an outcome-equivalent answer passes, a wrong one
// doesn't.
import { describe, expect, it } from 'vitest'
import { EVAL_BOT, type EvalOutcome, type EvalWrite } from './bot-automation-eval-host'
import { expectCreate, onlyCreate } from './bot-automation-eval-grading'
import { EVENT_SCENARIOS } from './bot-automation-eval-event-scenarios'

const bot = { botId: EVAL_BOT.id, runsIn: 'new', resultsTo: 'chat' }
const created = (on: Record<string, unknown>[]): EvalWrite => ({
  method: 'automation.create',
  params: { bot, on: on.map((rule) => ({ id: 'r1', ...rule })), prompt: 'Look at it.' },
  result: { id: 'a1' }
})
const outcome = (writes: EvalWrite[], reply = 'Set up.'): EvalOutcome => ({
  writes,
  commands: [],
  ownerTools: [],
  reply
})

describe('automation grading', () => {
  it('folds the bot’s own edits of what it made into it, and nothing else', () => {
    const edit: EvalWrite = {
      method: 'automation.update',
      params: { id: 'a1', updates: { prompt: 'Look at export bugs.' } }
    }
    expect(onlyCreate(outcome([created([]), edit]))).toMatchObject({
      params: { prompt: 'Look at export bugs.' }
    })
    expect(
      typeof onlyCreate(outcome([created([]), { ...edit, params: { ...edit.params, id: 'a9' } }]))
    ).toBe('string')
  })

  it('accepts any of several fair places for results, and fails any other', () => {
    const grade = expectCreate({ resultsTo: ['chat', 'none'] })
    const to = (resultsTo: unknown) =>
      grade(outcome([{ ...created([]), params: { bot: { ...bot, resultsTo }, prompt: 'x' } }]))
    expect(to('none')).toEqual([])
    expect(to('chat')).toEqual([])
    expect(to({ channel: 'C0DEPLOY012' })).toEqual(['results to {"channel":"C0DEPLOY012"}'])
  })

  it('accepts the subject’s own repository beside it, but no other', () => {
    const grade = expectCreate({
      triggers: [{ on: 'github.pr_pushed', subject: 'stablyai/orca#482' }]
    })
    const rule = { source: 'github', event: 'pr_pushed', subject: 'stablyai/orca#482' }
    expect(grade(outcome([created([{ ...rule, in: ['stablyai/orca'] }])]))).toEqual([])
    expect(grade(outcome([created([{ ...rule, in: ['acme/api'] }])]))).not.toEqual([])
  })

  it('lets a bot without the connector offer it, but build nothing', () => {
    const { grade } = EVENT_SCENARIOS.find(
      (scenario) => scenario.id === 'missing-github-connector'
    )!
    const offer: EvalWrite = { method: 'bots.connector.offer', params: { source: 'github' } }
    expect(grade(outcome([offer], 'I need GitHub connected first.'))).toEqual([])
    expect(grade(outcome([offer, created([])], 'I need GitHub connected first.'))).not.toEqual([])
  })
})
