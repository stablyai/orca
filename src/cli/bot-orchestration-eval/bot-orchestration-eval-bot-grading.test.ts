import { describe, expect, it } from 'vitest'
import type { EvalTurnOutcome } from './bot-orchestration-eval-conversation'
import { noDeadEnd, saysNowhere, sendsTo } from './bot-orchestration-eval-bot-grading'

const turn = (patch: Partial<EvalTurnOutcome> = {}): EvalTurnOutcome => ({
  reply: "I can't do docs work.",
  commands: [],
  writes: [],
  shell: [],
  tools: [],
  ownerTools: [],
  ...patch
})
const docs = noDeadEnd({ helpers: /\bDocs\b/ })

describe('noDeadEnd', () => {
  it('fails a bare refusal and passes any way forward', () => {
    expect(docs(turn())).toEqual(['left the asker at a dead end'])
    expect(docs(turn({ reply: 'Docs handles the docs site; ask it there.' }))).toEqual([])
    expect(docs(turn({ reply: 'Which project are the docs in?' }))).toEqual([])
    const offer = { method: 'bots.connector.offer', params: { source: 'linear' } }
    expect(docs(turn({ writes: [offer] }))).toEqual([])
    const handed = {
      method: 'orchestration.send',
      params: { to: 'bot:Docs', type: 'handoff' },
      result: { delivered: true as const, dispatchId: '' }
    }
    expect(docs(turn({ writes: [handed] }))).toEqual([])
  })

  it('fails a refused post, a bot that is not here, and a question with a plain answer', () => {
    const refused = {
      method: 'connector.post',
      params: {},
      result: { target: 'x', refused: true as const }
    }
    expect(docs(turn({ writes: [refused] }))).not.toEqual([])
    const ghost = {
      method: 'orchestration.send',
      params: { to: 'bot:Docs' },
      result: { delivered: false as const, error: 'There is no bot named Docs on this computer' }
    }
    expect(docs(turn({ reply: 'Docs has it.', writes: [ghost] }))).toEqual([
      'acted on a bot that is not here'
    ])
    const plain = noDeadEnd({ helpers: /(?!)/, plain: true })
    expect(plain(turn({ reply: 'Which project?' }))).toEqual([
      'asked what it could tell',
      'left the asker at a dead end'
    ])
  })
})

describe('the checks that hold on every path', () => {
  it('fails a leak in any write', () => {
    const leak = { method: 'orchestration.reply', params: { body: 'Acme credit offer' } }
    expect(saysNowhere('a secret', /Acme/)(turn({ writes: [leak] }))).not.toEqual([])
  })
})

describe('mention checks', () => {
  const send = (type: string, delivered: boolean) => ({
    method: 'orchestration.send',
    params: { to: 'bot:Docs', type },
    result: delivered
      ? { delivered: true as const, dispatchId: '' }
      : { delivered: false as const, error: 'x' }
  })
  it('passes only a delivered send of the asked type', () => {
    expect(sendsTo('Docs', 'handoff')(turn({ writes: [send('handoff', true)] }))).toEqual([])
    expect(sendsTo('Docs', 'handoff')(turn({ writes: [send('question', true)] }))).toEqual([
      'sent Docs the wrong type'
    ])
    expect(sendsTo('Docs', 'handoff')(turn({ writes: [send('handoff', false)] }))).toEqual([
      'never sent the mention to Docs'
    ])
  })
})
