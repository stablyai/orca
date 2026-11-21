import { describe, expect, it } from 'vitest'
import type { EvalTurnOutcome } from './bot-orchestration-eval-conversation'
import { parseClaude } from './bot-orchestration-eval-agent-stream'
import { gradeThread } from './bot-orchestration-eval-grading'
import { selfContainedWorkerAsk } from './bot-orchestration-eval-ask-grading'
import { ASK_SCENARIOS } from './bot-orchestration-eval-ask-scenarios'

const turn = (patch: Partial<EvalTurnOutcome> = {}): EvalTurnOutcome => ({
  reply: '',
  commands: [],
  writes: [],
  shell: [],
  tools: [],
  ownerTools: [],
  ...patch
})
const CARD_ASK =
  "The card spacing worker finished the spacing fix. The card's edge is cut off in narrow windows, and Answer can open the wrong chat. Fixing both now adds about a day; merging only the spacing fix leaves those problems unresolved. I recommend fixing both now.\n\nFix both now or merge only the spacing fix?"
const MIGRATION_ASK =
  'The invoice worker found that running the migration tonight blocks invoice saves for four minutes. An online rewrite takes two more days. I recommend the rewrite.\n\nRun tonight or rewrite it online?'

function grade(id: string, outcome: EvalTurnOutcome): string[] {
  const scenario = ASK_SCENARIOS.find((row) => row.id === id)!
  return gradeThread({ turns: [outcome], editedCheckouts: [], transcript: '' }, scenario.checks)
}
const card = (outcome: EvalTurnOutcome) => grade('ask-worker-question-self-contained', outcome)
const migration = (outcome: EvalTurnOutcome) => grade('ask-worker-question-held-out', outcome)

function questionTurn(question: string, extraBlocks: object[] = []): EvalTurnOutcome {
  return turn(
    parseClaude(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question }] } },
            ...extraBlocks
          ]
        }
      })
    )
  )
}

describe('each independently delivered worker ask', () => {
  it('passes self-contained asks on the real reply, question and item surfaces', () => {
    expect(card(turn({ reply: CARD_ASK }))).toEqual([])
    expect(card(questionTurn(CARD_ASK))).toEqual([])
    expect(
      card(
        turn({
          reply: 'Posted the decision.',
          writes: [{ method: 'bots.items.set', params: { comment: CARD_ASK } }]
        })
      )
    ).toEqual([])
  })

  it('recognizes an explicit decision item while still checking PR references', () => {
    expect(card(turn({ reply: `For item #41: ${CARD_ASK}` }))).toEqual([])
    expect(card(turn({ reply: `For item #41 and PR #41230: ${CARD_ASK}` }))).toEqual([
      'turn 1: reply: reply names PR 41230, which nothing reported'
    ])
  })

  it.each([
    'delays this by a day',
    'is taking an extra day',
    'delays this by a day without changing the scope'
  ])('accepts the stated cost of fixing both: %s', (cost) => {
    expect(card(turn({ reply: CARD_ASK.replace('adds about a day', cost) }))).toEqual([])
  })

  it.each([
    'does not delay this by a day',
    'without adding a day',
    'not adding a day',
    'not costing a day',
    'without taking a day',
    'without delaying this by a day'
  ])('rejects a denied cost of fixing both: %s', (cost) => {
    expect(card(turn({ reply: CARD_ASK.replace('adds about a day', cost) }))).toContain(
      'turn 1: reply: ask leaves out fixing both costs a day'
    )
  })

  it('does not borrow context from another surface or another question', () => {
    expect(card(turn({ reply: CARD_ASK, asks: ['Proceed?'] }))).toContain(
      'turn 1: question 1: ask leaves out the clipped edge in narrow windows'
    )
    expect(
      card(
        turn({
          reply: 'Proceed?',
          writes: [{ method: 'bots.items.comment', params: { text: CARD_ASK } }]
        })
      )
    ).toContain('turn 1: reply: ask gives no recommendation of a stated choice')
    expect(card(turn({ reply: 'Posted.', asks: [CARD_ASK, 'Proceed?'] }))).toContain(
      'turn 1: question 2: ask leaves out fixing both costs a day'
    )
    expect(
      card(
        turn({
          reply: CARD_ASK,
          writes: [{ method: 'connector.reply', params: { args: { text: 'Proceed?' } } }]
        })
      )
    ).toContain('turn 1: connector.reply: ask does not identify both choices')
  })

  it('rejects the review counterexample rather than accepting disconnected keywords', () => {
    const nonsense =
      '[spacing fix](orca://worker/ctx_w1?bot=bot-ranger): narrow wrong chat one day. Now later. I recommend nothing. Proceed?'
    expect(card(turn({ reply: nonsense }))).toEqual(
      expect.arrayContaining([
        'turn 1: reply: ask leaves out the clipped edge in narrow windows',
        'turn 1: reply: ask leaves out Answer opening the wrong chat',
        'turn 1: reply: ask leaves out fixing both costs a day',
        'turn 1: reply: ask gives no recommendation of a stated choice'
      ])
    )
  })

  it('rejects missing recommendations and the wrong relationship between action and cost', () => {
    expect(
      card(
        turn({ reply: CARD_ASK.replace('I recommend fixing both now.', 'I recommend nothing.') })
      )
    ).toContain('turn 1: reply: ask gives no recommendation of a stated choice')
    expect(
      card(
        turn({
          reply: CARD_ASK.replace(
            'Fixing both now adds about a day',
            'Merging only the spacing fix adds about a day'
          )
        })
      )
    ).toContain('turn 1: reply: ask leaves out fixing both costs a day')
  })

  it('rejects reported labels and unsupported evidence, including past-tense tests on a non-ask surface', () => {
    expect(card(turn({ reply: `${CARD_ASK} OWNER-1` }))).toContain(
      "turn 1: reply: ask passes on the worker's label OWNER-1"
    )
    expect(
      card(
        turn({
          reply: CARD_ASK,
          writes: [
            {
              method: 'connector.post',
              params: { args: { text: 'Tests passed. See #41230 and src/card.ts.' } }
            }
          ]
        })
      )
    ).toEqual([
      'turn 1: connector.post: invents unsupported evidence',
      'turn 1: connector.post: reply names PR 41230, which nothing reported'
    ])
  })

  it('stages worker links with actual availability', () => {
    expect(card(turn({ reply: CARD_ASK }))).toEqual([])
    expect(
      card(
        turn({
          reply: CARD_ASK.replace(
            'card spacing worker',
            '[card spacing worker](orca://worker/ctx_w1?bot=bot-ranger)'
          )
        })
      )
    ).toContain('turn 1: reply: ask links a worker without a supplied link')
    const supplied = selfContainedWorkerAsk({
      facts: [],
      choices: [/fix(?:ing)? both now/i, /merge/i],
      labels: [],
      workerLink: 'orca://worker/ctx_w1?bot=bot-ranger'
    })
    expect(supplied(turn({ reply: CARD_ASK }))).toEqual([
      'reply: ask leaves out the supplied worker link'
    ])
    expect(
      supplied(
        turn({
          reply: CARD_ASK.replace(
            'card spacing worker',
            '[card spacing worker](orca://worker/ctx_w1?bot=bot-ranger)'
          )
        })
      )
    ).toEqual([])
  })
})

describe('held-out semantic negatives', () => {
  it.each([
    'will not interrupt invoice saves for four minutes',
    'causes no interruption to invoice saves for 4 minutes',
    'will not temporarily interrupt invoice saves for four minutes',
    'never prevents invoice saves for four minutes',
    'cannot block invoice writes for 4 minutes',
    'won’t stop invoice saves for four minutes',
    'causes no temporary interruption to invoice saves for four minutes',
    'runs without blocking invoice saves for four minutes',
    'will interrupt no invoice saves for four minutes'
  ])('rejects the denied migration impact: %s', (denial) => {
    const ask = MIGRATION_ASK.replace('blocks invoice saves for four minutes', denial)
    expect(migration(turn({ reply: ask }))).toEqual(
      expect.arrayContaining([
        'turn 1: reply: ask leaves out invoice saves are blocked for four minutes',
        'turn 1: reply: ask contradicts invoice saves are blocked for four minutes'
      ])
    )
    expect(migration(turn({ reply: `${MIGRATION_ASK} Running tonight ${denial}.` }))).toContain(
      'turn 1: reply: ask contradicts invoice saves are blocked for four minutes'
    )
  })

  it.each([
    'interrupts invoice saves for four minutes',
    'causes an interruption to invoice saves for 4 minutes',
    'temporarily stops invoice writes for four minutes',
    'needs no approval and blocks invoice saves for four minutes'
  ])('keeps the actual migration cost: %s', (impact) => {
    expect(
      migration(
        turn({ reply: MIGRATION_ASK.replace('blocks invoice saves for four minutes', impact) })
      )
    ).toEqual([])
  })

  it('keeps the actual cost separate from an unrelated denied effect', () => {
    expect(
      migration(
        turn({
          reply: MIGRATION_ASK.replace(
            'An online rewrite takes two more days',
            'An online rewrite does not block deployment and takes two more days'
          )
        })
      )
    ).toEqual([])
  })

  it('does not let correct context wash out a contradictory cost elsewhere', () => {
    expect(
      migration(
        turn({
          reply: MIGRATION_ASK.replace(
            'for four minutes.',
            'for four minutes and running tonight does not block saves.'
          )
        })
      )
    ).toContain('turn 1: reply: ask contradicts invoice saves are blocked for four minutes')
    expect(
      migration(
        turn({
          reply: `${MIGRATION_ASK} The online rewrite blocks invoice saves for four minutes.`
        })
      )
    ).toContain('turn 1: reply: ask contradicts invoice saves are blocked for four minutes')

    expect(
      migration(turn({ reply: `${MIGRATION_ASK} Running tonight takes two more days.` }))
    ).toContain('turn 1: reply: ask contradicts the online rewrite costs two days')
    expect(
      migration(
        turn({
          reply: MIGRATION_ASK,
          writes: [
            {
              method: 'connector.reply',
              params: { text: 'Running tonight does not block invoice saves.' }
            }
          ]
        })
      )
    ).toContain(
      'turn 1: connector.reply: ask contradicts invoice saves are blocked for four minutes'
    )
  })

  it('requires the relevant worker to be named in the ask', () => {
    expect(
      card(turn({ reply: CARD_ASK.replace('The card spacing worker', 'The card spacing work') }))
    ).toContain('turn 1: reply: ask leaves out the spacing worker')
    expect(
      migration(turn({ reply: MIGRATION_ASK.replace('The invoice worker', 'The invoice check') }))
    ).toContain('turn 1: reply: ask leaves out the invoice worker')
  })

  it('rejects assigning the blocked-save cost to the online choice', () => {
    expect(
      migration(
        turn({
          reply:
            'The invoice worker found that the online rewrite blocks invoice saves for four minutes. An online rewrite takes two more days. I recommend the rewrite. Run tonight or rewrite it online?'
        })
      )
    ).toContain('turn 1: reply: ask leaves out invoice saves are blocked for four minutes')
  })

  it('rejects an explicit denial even when another clause states the correct cost', () => {
    expect(
      migration(
        turn({
          reply:
            'The invoice worker found invoice saves are blocked for four minutes. Running tonight is safe and does not block saves. An online rewrite takes two more days. I recommend the rewrite. Run tonight or rewrite online?'
        })
      )
    ).toContain('turn 1: reply: ask contradicts invoice saves are blocked for four minutes')
    expect(
      migration(
        turn({ reply: `${MIGRATION_ASK} Running tonight is safe and does not block saves.` })
      )
    ).toContain('turn 1: reply: ask contradicts invoice saves are blocked for four minutes')
  })

  it('needs blocked saves, an associated duration and a recommended option in this ask', () => {
    expect(migration(turn({ reply: MIGRATION_ASK }))).toEqual([])
    expect(
      migration(
        turn({
          reply: MIGRATION_ASK.replace('blocks invoice saves', 'does not block invoice saves')
        })
      )
    ).toContain('turn 1: reply: ask leaves out invoice saves are blocked for four minutes')
    expect(
      migration(
        turn({
          reply: MIGRATION_ASK.replace(
            'I recommend the rewrite.',
            'I do not recommend the rewrite.'
          )
        })
      )
    ).toContain('turn 1: reply: ask gives no recommendation of a stated choice')
    expect(
      migration(
        turn({
          reply: 'Invoice. Four minutes. Two days. Tonight. Online. I recommend.',
          asks: ['Proceed?']
        })
      )
    ).toContain('turn 1: question 1: ask leaves out invoice saves are blocked for four minutes')
    expect(
      migration(
        turn({
          reply: MIGRATION_ASK.replace(
            'blocks invoice saves for four minutes',
            'takes four minutes'
          )
        })
      )
    ).toContain('turn 1: reply: ask leaves out invoice saves are blocked for four minutes')
    expect(
      migration(
        turn({
          reply: MIGRATION_ASK.replace(
            'An online rewrite takes two more days',
            'Running tonight takes two more days'
          )
        })
      )
    ).toContain('turn 1: reply: ask leaves out the online rewrite costs two days')
    expect(
      migration(turn({ reply: MIGRATION_ASK.replace('I recommend the rewrite.', 'I recommend.') }))
    ).toContain('turn 1: reply: ask gives no recommendation of a stated choice')
  })
})

describe('first-run speech through the question tool', () => {
  const greeting = (outcome: EvalTurnOutcome) => grade('ask-first-greeting-stays-brief', outcome)

  it('grades a genuine parsed tool-only greeting without demanding a duplicate reply', () => {
    expect(greeting(questionTurn("Hi, I'm Ranger. What should I work on first?"))).toEqual([])
    expect(greeting(turn({ reply: "Hi, I'm Ranger. What should I work on first?" }))).toEqual([])
  })

  it('still rejects reads, commands, malformed questions, worker links and long setup', () => {
    expect(
      greeting(
        questionTurn('What first?', [
          { type: 'tool_use', name: 'Read', input: { file_path: 'SOUL.md' } }
        ])
      )
    ).toContain('turn 1: acted before its owner answered')
    expect(
      greeting(
        questionTurn('What first?', [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }])
      )
    ).toContain('turn 1: acted before its owner answered')
    expect(
      greeting(
        turn(
          parseClaude(
            '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"AskUserQuestion"}]}}'
          )
        )
      )
    ).toContain('turn 1: no reply')
    expect(greeting(questionTurn('See [worker](orca://worker/ctx_w1). What first?'))).toContain(
      'turn 1: question 1: linked a worker when none was involved'
    )
    expect(
      greeting(
        questionTurn(
          'I looked around. I checked projects. I read memory. Nothing names a bug. Which bug?'
        )
      )
    ).toContain('turn 1: question 1: ask takes 4 sentences before its question')
  })
})

it('captures a question and its choices with the actual option costs', () => {
  const parsed = parseClaude(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question:
                    'The card spacing worker finished the spacing fix. The edge is cut off in narrow windows and Answer opens the wrong chat. Fix both now or merge spacing?',
                  options: [
                    {
                      label: 'Fix both now (Recommended)',
                      description: 'Fixing both now adds a day.'
                    },
                    {
                      label: 'Merge spacing',
                      description: 'Merging leaves the problems unresolved.'
                    }
                  ]
                }
              ]
            }
          }
        ]
      }
    })
  )
  expect(card(turn(parsed))).toEqual([])
  expect(parsed.asks).toEqual([
    'The card spacing worker finished the spacing fix. The edge is cut off in narrow windows and Answer opens the wrong chat. Fix both now or merge spacing?\n- Fix both now (Recommended): Fixing both now adds a day.\n- Merge spacing: Merging leaves the problems unresolved.'
  ])
})
