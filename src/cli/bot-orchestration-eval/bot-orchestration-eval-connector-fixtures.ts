// The worlds the connector-verb scenarios play out in: a thread holding the bot's own earlier reply,
// and a worker's report carrying a long log; the Linear issues and Slack people they ask about are
// the shared worlds' (bot-automation-eval-linear-world.json, bot-automation-eval-slack-world.json). Messages reach the bot as Orca writes them
// (connectorAskerPrompt).
import { connectorAskerPrompt } from '../../shared/connector-asker-prompt'
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import { EVAL_BOT, type EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'
import { OWNER_SLACK_ID } from '../bot-automation-eval/bot-automation-eval-slack'
import {
  EMPTY_WORLD,
  ORCA_REPO,
  runningWorker,
  workerDone,
  workspace
} from './bot-orchestration-eval-fixtures'

type World = Partial<EvalHostState>

export const BOB_SLACK_ID = 'U0BOB'
export const EXPORTS_CHANNEL = 'C0EXPORTS'

const OWNER: Pick<ConnectorAsker, 'userId' | 'name' | 'role'> = {
  userId: OWNER_SLACK_ID,
  name: 'Alice',
  role: 'owner'
}
/** A teammate in #exports and #platform-eng, but not in the owner's private #leads or DMs. */
export const NORA: Pick<ConnectorAsker, 'userId' | 'name' | 'role'> = {
  userId: 'U0NORA',
  name: 'Nora',
  role: 'member'
}

/** A message as Orca hands it to the bot: who asked (the owner unless named), where, and their words. */
export function asked(
  source: 'slack' | 'linear',
  place: ConnectorAsker['place'],
  text: string,
  asker = OWNER
): string {
  return connectorAskerPrompt(source, { ...asker, place, text, context: [] })
}

export const inExports = (text: string) =>
  asked('slack', { kind: 'public_channel', id: EXPORTS_CHANNEL }, text)

/** In the Linear world, the Platform team's three open bugs, and a closed bug and an open feature a
 *  list must leave out. */
export const PLATFORM_OPEN_BUGS = ['PLAT-41', 'PLAT-44', 'PLAT-47']
export const PLATFORM_OTHERS = ['PLAT-39', 'PLAT-45']

const EXPORTS_REF = `slack:${EVAL_BOT.slack.teamId}:${EXPORTS_CHANNEL}`
/** The bot's reply in #exports, as a read names it; a correction edits it in place. */
export const BOT_REPLY_REF = `${EXPORTS_REF}::m2`

export const EXPORTS_THREAD_WORLD: World = {
  ...EMPTY_WORLD,
  conversation: { source: 'slack', title: 'exports stalling' },
  places: [
    {
      ref: EXPORTS_REF,
      label: '#exports',
      messages: [
        { author: 'Alice', text: 'where is the exports stall bug at?' },
        { author: EVAL_BOT.name, text: 'ENG-9310 is in Triage and nobody has it yet.' }
      ]
    }
  ]
}

// A log line deep in the worker's report: an attachment carries it, a reply should not.
const LOG_MARKER = 'ECONNRESET at export-worker.ts:212'
/** The worker's log, line by line: an attachment carries all of it. */
export const EXPORT_LOG_LINES = Array.from({ length: 60 }, (_, index) =>
  index === 47
    ? `[12:04:${String(index).padStart(2, '0')}] ${LOG_MARKER}`
    : `[12:04:${String(index).padStart(2, '0')}] export chunk ${index + 1}/60 written`
)

export const LOG_DONE = workerDone(
  'ctx_w1',
  `Reproduced the stall: the export worker loses its connection on chunk 48 and never retries. Full log:\n${EXPORT_LOG_LINES.join('\n')}`
)

const STALL_WORKSPACE = workspace({
  repoId: ORCA_REPO,
  repo: 'orca',
  name: 'eng-9310-export-stall',
  state: 'working',
  byBot: true,
  prompt: 'ENG-9310: find why exports stall at 99%.',
  last: 'Reproducing on a large workspace.'
})

/** The exports thread, whose worker is about to report with its log. */
export const STALL_WORKER_WORLD: World = {
  ...EXPORTS_THREAD_WORLD,
  worktrees: [STALL_WORKSPACE],
  workers: [runningWorker(STALL_WORKSPACE.worktreeId, 'ENG-9310: find why exports stall at 99%.')],
  recorded: [
    { dispatchId: 'ctx_w1', source: 'slack', externalId: 'eval-thread', title: 'exports stalling' }
  ]
}

/** #exports, where Bob dropped the worker's log as a file: only the file holds the error. */
export const LOG_FILE_WORLD: World = {
  ...EMPTY_WORLD,
  conversation: { source: 'slack', title: 'exports stalling' },
  places: [
    {
      ref: EXPORTS_REF,
      label: '#exports',
      messages: [
        { author: 'Alice', text: 'anyone have the log from the stalled export?' },
        {
          author: 'Bob Lee',
          text: 'here you go',
          files: [
            {
              id: 'F0EXPORTLOG',
              name: 'export-worker.log',
              type: 'text/plain',
              content: EXPORT_LOG_LINES.join('\n')
            }
          ]
        }
      ]
    }
  ]
}
