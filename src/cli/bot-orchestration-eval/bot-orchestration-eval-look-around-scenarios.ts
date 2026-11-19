import { lookAroundPrompt } from '../../main/bots/bot-look-around-prompt'
import { EMPTY_BOT_LOOK } from '../../main/bots/bot-look-around-state'
import { EVAL_BOT } from '../bot-automation-eval/bot-automation-eval-host'
import { AUTOMATION_FIXTURES, FIXTURES } from './bot-orchestration-eval-adoption-fixtures'
import {
  adoptionWorld,
  idOf,
  OTHER_BOTS,
  OTHER_BOT_SOULS
} from './bot-orchestration-eval-adoption-world'
import {
  neverSuggestsHandoff,
  suggestsHandoff,
  suggestsNothing
} from './bot-orchestration-eval-look-around-grading'
import type { OrchestrationScenario } from './bot-orchestration-eval-scenarios'

const history = { open: [], started: [], dismissed: [] }
const AUTOMATIONS_SOUL =
  'I coordinate automation work in Orca, keeping the agents and their PRs moving and bringing decisions to my owner.'
const SELF = { ...EVAL_BOT, agent: 'claude' as const }

export const LOOK_AROUND_SCENARIOS: OrchestrationScenario[] = [
  {
    id: 'look-adopt-grouping-and-ownership',
    soul: AUTOMATIONS_SOUL,
    turns: [{ message: lookAroundPrompt({ focus: '', history }) }],
    state: {
      ...adoptionWorld([
        ...AUTOMATION_FIXTURES.slice(0, 2),
        { ...AUTOMATION_FIXTURES[2]!, bot: 'Shipper' },
        FIXTURES.GPU_LOADER
      ]),
      bots: [SELF, ...OTHER_BOTS],
      souls: { ...OTHER_BOT_SOULS, [SELF.id]: AUTOMATIONS_SOUL },
      lookAround: EMPTY_BOT_LOOK
    },
    checks: [
      [
        suggestsHandoff({
          bot: EVAL_BOT.name,
          include: AUTOMATION_FIXTURES.slice(0, 2).map(idOf),
          forbid: [idOf(AUTOMATION_FIXTURES[2]!), idOf(FIXTURES.GPU_LOADER)],
          nextStep: /review|retry|test|CI|check/i
        })
      ]
    ]
  },
  {
    id: 'look-adopt-other-bot',
    soul: 'I coordinate Orca engineering work and find the right bot for each area.',
    turns: [{ message: lookAroundPrompt({ focus: '', history }) }],
    state: {
      ...adoptionWorld([FIXTURES.WEBHOOKS]),
      bots: [SELF, ...OTHER_BOTS],
      souls: OTHER_BOT_SOULS,
      lookAround: EMPTY_BOT_LOOK
    },
    checks: [
      [
        suggestsHandoff({
          bot: 'Atlas',
          include: [idOf(FIXTURES.WEBHOOKS)],
          nextStep: /build|CI|check|merge/i
        })
      ]
    ]
  },
  {
    id: 'look-adopt-dismissed',
    soul: AUTOMATIONS_SOUL,
    turns: [
      {
        message: lookAroundPrompt({
          focus: '',
          history: {
            ...history,
            dismissed: [
              'Hand automation-results-design to Ranger to coordinate its review and follow-ups'
            ]
          }
        })
      }
    ],
    state: {
      ...adoptionWorld([AUTOMATION_FIXTURES[1]!]),
      bots: [SELF],
      lookAround: EMPTY_BOT_LOOK
    },
    checks: [
      [
        neverSuggestsHandoff({
          id: idOf(AUTOMATION_FIXTURES[1]!),
          name: AUTOMATION_FIXTURES[1]!.name
        })
      ]
    ]
  },
  {
    id: 'look-adopt-respects-focus',
    soul: AUTOMATIONS_SOUL,
    turns: [
      {
        message: lookAroundPrompt({
          focus: 'Only failing CI checks on the ml-pipeline project.',
          history
        })
      }
    ],
    state: {
      ...adoptionWorld(AUTOMATION_FIXTURES),
      bots: [SELF],
      lookAround: EMPTY_BOT_LOOK
    },
    checks: [[suggestsNothing]]
  }
]
