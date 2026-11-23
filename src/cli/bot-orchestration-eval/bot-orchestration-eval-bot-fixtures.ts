// The worlds the bot-to-bot scenarios play out in: Ranger (the bot under test, which triages bugs)
// and Docs (which keeps the docs site), the people who ask them, and the mail one sends the other.
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import { EVAL_BOT, type EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'
import {
  botAnswerMail,
  botRequestMail,
  botUnansweredMail,
  evalAskers,
  type StandInBot
} from './bot-orchestration-eval-bots'
import { asked, EXPORTS_CHANNEL, NORA } from './bot-orchestration-eval-connector-fixtures'
import { EMPTY_WORLD, WOKEN } from './bot-orchestration-eval-fixtures'
import type { EvalTurn } from './bot-orchestration-eval-conversation'

type World = Partial<EvalHostState>

/** A world as the full state the stand-in keeps. */
const asState = (world: World): EvalHostState => ({
  bots: [],
  automations: [],
  timezone: 'UTC',
  repos: [],
  ...world
})
type Asker = Pick<ConnectorAsker, 'userId' | 'name' | 'role'>

/** In Docs's Who can ask; Nora isn't. */
export const DANA: Asker = { userId: 'U0DANA', name: 'Dana', role: 'member' }
export { NORA }

export const RANGER_SOUL =
  'I triage bugs: I reproduce what people report in our code and get it fixed.'
const DOCS_SOUL = 'I keep the docs site current: install guides, reference pages and release notes.'

export const RANGER: StandInBot = { ...EVAL_BOT, agent: 'claude' }
export const DOCS: StandInBot = {
  id: 'bot-docs',
  name: 'Docs',
  agent: 'claude',
  slack: { appId: 'A0DOCS', teamId: EVAL_BOT.slack.teamId },
  github: {},
  linear: EVAL_BOT.linear,
  members: [
    {
      id: DANA.userId,
      name: 'Dana',
      source: 'slack',
      workspaceId: EVAL_BOT.slack.teamId
    }
  ]
}

const THREAD = { channel: EXPORTS_CHANNEL, thread: '1712.1' }
const DM = { channel: 'D0DANA', thread: 'D0DANA' }
/** #exports, where Dana asks and a handed-over job is answered. */
const EXPORTS_REF = `slack:${EVAL_BOT.slack.teamId}:${EXPORTS_CHANNEL}`
const REQUEST_ID = 'msg_req_1'

/** Ranger and these bots, with their souls; a person's thread when an asker is named, else the
 *  owner's Chat. */
export function botsWorld(input: { asker?: Asker; dm?: true; bots?: StandInBot[] } = {}): World {
  const { asker } = input
  return {
    ...EMPTY_WORLD,
    bots: input.bots ?? [RANGER, DOCS],
    souls: { [RANGER.id]: RANGER_SOUL, [DOCS.id]: DOCS_SOUL },
    ...(asker
      ? {
          conversation: {
            source: 'slack' as const,
            title: 'a request',
            asker: asker.userId,
            ...(asker.name ? { askerName: asker.name } : {}),
            slack: input.dm ? DM : THREAD
          }
        }
      : {})
  }
}

/** A person's Slack message in #exports, or in a DM with the bot. */
export function from(asker: Asker, text: string, dm?: true): string {
  return asked(
    'slack',
    dm
      ? { kind: 'direct_message', id: DM.channel }
      : { kind: 'public_channel', id: THREAD.channel },
    text,
    asker
  )
}

/** The turn Docs's request wakes Ranger for, in a background session no person's thread is tied to.
 *  `asked` is the world Docs was asked in. */
export function handedIn(input: {
  asked: World
  purpose?: 'handoff' | 'question'
  subject: string
  body: string
  memory?: string
  state?: World
}): { turns: EvalTurn[]; state: World; memory?: string } {
  const world = { ...input.asked, conversation: undefined }
  return {
    // The thread's channel is one the bot can post in, as the request's answer says.
    state: {
      ...world,
      places: [{ ref: EXPORTS_REF, label: '#exports' }],
      actingOnRequest: { depth: 1, askers: evalAskers(asState(input.asked)) },
      ...input.state
    },
    ...(input.memory ? { memory: input.memory } : {}),
    turns: [
      {
        message: WOKEN,
        mail: [
          botRequestMail({
            id: REQUEST_ID,
            from: DOCS,
            state: asState(input.asked),
            purpose: input.purpose ?? 'handoff',
            subject: input.subject,
            body: input.body
          })
        ]
      }
    ]
  }
}

/** A Linear issue's thread, where Docs's app (shared by every bot of the owner) was asked. */
export const LINEAR_ASKED: World = {
  ...botsWorld(),
  conversation: {
    source: 'linear',
    title: 'ENG-9400',
    asker: DANA.userId,
    askerName: 'Dana'
  }
}

/** Docs's answer to Ranger's handoff (or question), by mail. */
export function docsAnswer(
  world: World,
  subject: string,
  body: string,
  purpose: 'handoff' | 'question' = 'handoff'
) {
  return botAnswerMail({
    id: 'msg_answer_1',
    from: DOCS,
    state: asState(world),
    purpose,
    inReplyTo: 'msg_bot_1',
    subject,
    body
  })
}

/** Docs read Ranger's handoff and ended its turn with no reply. */
export function docsSilent(world: World, subject: string) {
  return botUnansweredMail({
    id: 'msg_answer_1',
    from: DOCS,
    state: asState(world),
    purpose: 'handoff',
    inReplyTo: 'msg_bot_1',
    subject
  })
}
