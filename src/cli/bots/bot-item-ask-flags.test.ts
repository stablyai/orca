import { expect, it } from 'vitest'
import { COMMAND_SPECS } from '../specs/index'
import { BOT_ITEM_ASK_BOOLEAN_FLAGS } from '../specs/bot-items'
import { normalizeCommandPositionals, parseArgs } from '../arguments/args'
import { specPaths } from '../discovery/command-spec'
import { botItemAskFromFlags, botItemAskParams } from './bot-item-ask-flags'

function askOf(argv: string[]): ReturnType<typeof botItemAskFromFlags> {
  const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
  const { flags } = normalizeCommandPositionals(
    COMMAND_SPECS,
    parseArgs(argv, paths, COMMAND_SPECS)
  )
  return botItemAskFromFlags({ flags, rawArgs: argv }, BOT_ITEM_ASK_BOOLEAN_FLAGS)
}

it('groups each option, recommendation and --multi under the --ask before it', () => {
  const ask = askOf([
    'bot',
    'item',
    'set',
    '4',
    '--status',
    'needs-you',
    '--comment',
    'Until you answer, the worker waits.',
    '--ask',
    'OpenCode plugins have no removal path. What should this PR do?',
    '--option',
    'Defer to a follow-up PR | lands faster',
    '--option',
    'Remove them here',
    '--recommended',
    '1',
    '--ask',
    'Which days can the demo run?',
    '--multi',
    '--option=Monday',
    '--option',
    'Wednesday',
    '--ask',
    'What should the tooltip say?'
  ])

  expect(ask).toEqual({
    questions: [
      {
        prompt: 'OpenCode plugins have no removal path. What should this PR do?',
        options: [
          { label: 'Defer to a follow-up PR', detail: 'lands faster' },
          { label: 'Remove them here' }
        ],
        recommended: 0
      },
      {
        prompt: 'Which days can the demo run?',
        options: [{ label: 'Monday' }, { label: 'Wednesday' }],
        multi: true
      },
      { prompt: 'What should the tooltip say?', options: [] }
    ]
  })
})

it('refuses an option with no --ask before it, and a recommendation that names no option', () => {
  expect(() => askOf(['bot', 'item', 'set', '4', '--option', 'Defer'])).toThrow(
    /goes after the --ask/
  )
  expect(() =>
    askOf(['bot', 'item', 'set', '4', '--ask', 'Ship?', '--recommended', '1', '--option', 'Yes'])
  ).toThrow(/--recommended takes the number of an option given before it/)
})

it('refuses an --ask with no question rather than drop it', () => {
  expect(() => askOf(['bot', 'item', 'set', '4', '--status', 'needs-you', '--ask', ''])).toThrow(
    /--ask needs its question/
  )
})

it('leaves a set without --ask as it was', () => {
  expect(
    askOf(['bot', 'item', 'set', '4', '--status', 'needs-you', '--comment', 'Ship?'])
  ).toBeUndefined()
})

it('refuses a value on --multi rather than read --multi=false as on', () => {
  expect(() =>
    askOf([
      'bot',
      'item',
      'set',
      '4',
      '--ask',
      'Days?',
      '--option',
      'Mon',
      '--option',
      'Tue',
      '--multi=false'
    ])
  ).toThrow(/--multi takes no value/)
})

it('sends the context inside the ask, and the whole ask as the comment a host without asks keeps', () => {
  const questions = [{ prompt: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }]

  expect(botItemAskParams({ questions }, 'The build is green.')).toEqual({
    ask: { context: 'The build is green.', questions },
    comment: 'The build is green.\n\nShip it?\n   - Yes\n   - No'
  })
  expect(botItemAskParams({ questions }, undefined)).toEqual({
    ask: { questions },
    comment: 'Ship it?\n   - Yes\n   - No'
  })
})
