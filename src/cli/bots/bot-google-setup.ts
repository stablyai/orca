// `orca bot google-setup …`: the bot moves its Google setup run; Orca draws the cards from it.
import {
  readInjectedAgentSessionId,
  readInjectedBotToken
} from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import {
  currentGoogleSetupStep,
  GOOGLE_SETUP_STEPS,
  type GoogleSetupRun
} from '../../shared/google/google-setup-run'
import {
  googleSetupActionsLine,
  googleSetupBlockerLine,
  type GoogleSetupBlocker
} from '../../shared/google/google-setup-blocker'
import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { callBots } from './bot'

type Change = Record<string, unknown> & { action: string }

/** The bot run's token names the bot; its chat id says where it ran. */
function botCaller(): { botToken?: string; callerSessionId: string } {
  const id = readInjectedAgentSessionId()
  if (!id) {
    throw new RuntimeClientError('invalid_argument', "Run this from a bot's chat.")
  }
  const botToken = readInjectedBotToken()
  return { ...(botToken ? { botToken } : {}), callerSessionId: id }
}

type SetupRead = {
  run: GoogleSetupRun | null
  blocker?: GoogleSetupBlocker | null
  keyMissing?: boolean
}

/** What the owner must do now: a blocker's buttons, or the sign-in the connect card waits for. */
function ownerLines(run: GoogleSetupRun, blocker: GoogleSetupBlocker | null): string[] {
  if (blocker) {
    return [
      `Waiting on your owner: ${googleSetupBlockerLine(blocker)}`,
      `Your owner's card shows: ${googleSetupActionsLine(blocker)}`
    ]
  }
  if (run.state === 'running' && currentGoogleSetupStep(run) === 'connect') {
    return [
      'Waiting on your owner: sign in on the Connect Google card.',
      "Your owner's card shows: Sign in to Google"
    ]
  }
  return []
}

/** "Do it for me · on apis · account done (bot), project done (bot), apis active". */
export function formatGoogleSetupRun({
  run,
  blocker = null,
  keyMissing = false
}: SetupRead): string {
  if (!run) {
    return 'No Google setup has started for this bot.'
  }
  const steps = GOOGLE_SETUP_STEPS.map((step) => {
    const state = run.steps[step]
    const by = state?.by ? ` (${state.by})` : ''
    const note = state?.note ? `: ${state.note}` : ''
    return `  ${step}: ${state?.status ?? 'pending'}${by}${note}`
  })
  const answers = Object.entries(run.answers).map(
    ([card, answer]) => `  ${card}: ${answer?.values.join(', ')}${answer?.typed ? ' (typed)' : ''}`
  )
  const current = currentGoogleSetupStep(run)
  return [
    `Google setup ${run.state}, ${run.mode === 'unchosen' ? 'path not chosen yet' : run.mode}${run.personStep ? `, the person does ${run.personStep}` : ''}${current && run.state === 'running' ? `, on ${current}` : ''}`,
    ...(run.account ? [`Account: ${run.account}${run.kind ? ` (${run.kind})` : ''}`] : []),
    ...(run.projectId ? [`Project: ${run.projectId}`] : []),
    ...(run.services?.length ? [`Services: ${run.services.join(', ')}`] : []),
    ...(run.browserPageId ? [`Page: ${run.browserPageId}`] : []),
    'Steps:',
    ...steps,
    ...(answers.length ? ['Answers:', ...answers] : []),
    ...(run.lastError ? [`Last error: ${run.lastError}`] : []),
    ...(keyMissing
      ? ["Key: Orca doesn't have the app's key yet. Client is done only once it does."]
      : []),
    // The owner's buttons, in the card's own words, so the bot never names one that isn't there.
    ...ownerLines(run, blocker)
  ].join('\n')
}

function list(raw: string | undefined): string[] | undefined {
  const values = raw
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return values?.length ? values : undefined
}

/** A start Orca answered with a Connect card or a line instead of a setup, since Google's app is here. */
type StartRouted = { routed: 'offer' | 'on' | 'server'; message: string }

export function formatGoogleSetupWrite(result: SetupRead | StartRouted): string {
  return 'routed' in result ? result.message : formatGoogleSetupRun(result)
}

function write(change: Change): CommandHandler {
  return async ({ client, json }) => {
    const result = await callBots<SetupRead | StartRouted>(client, 'bots.googleSetup.write', {
      ...botCaller(),
      change
    })
    printResult(result, json, formatGoogleSetupWrite)
  }
}

const defined = (fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))

export const BOT_GOOGLE_SETUP_HANDLERS: Record<string, CommandHandler> = {
  'bot google-setup show': async ({ client, json }) => {
    const result = await callBots<SetupRead>(client, 'bots.googleSetup.read', botCaller())
    printResult(result, json, formatGoogleSetupRun)
  },
  'bot google-setup start': (context) =>
    write({
      action: 'start',
      ...defined({
        mode: getOptionalStringFlag(context.flags, 'mode'),
        browserPageId: getOptionalStringFlag(context.flags, 'page')
      })
    })(context),
  'bot google-setup step': (context) =>
    write({
      action: 'step',
      step: getRequiredStringFlag(context.flags, 'step'),
      status: getRequiredStringFlag(context.flags, 'status'),
      ...defined({ note: getOptionalStringFlag(context.flags, 'note') })
    })(context),
  'bot google-setup need-user': (context) =>
    write({
      action: 'need-user',
      step: getRequiredStringFlag(context.flags, 'step'),
      note: getRequiredStringFlag(context.flags, 'note')
    })(context),
  'bot google-setup set': (context) => {
    const fields = defined({
      account: getOptionalStringFlag(context.flags, 'account'),
      accounts: list(getOptionalStringFlag(context.flags, 'accounts')),
      kind: getOptionalStringFlag(context.flags, 'kind'),
      projectId: getOptionalStringFlag(context.flags, 'project'),
      services: list(getOptionalStringFlag(context.flags, 'services')),
      browserPageId: getOptionalStringFlag(context.flags, 'page')
    })
    if (Object.keys(fields).length === 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Set at least one of --account, --accounts, --kind, --project, --services or --page.'
      )
    }
    return write({ action: 'set', ...fields })(context)
  },
  'bot google-setup answer': (context) => {
    const values = list(getRequiredStringFlag(context.flags, 'values'))
    if (!values) {
      throw new RuntimeClientError('invalid_argument', '--values needs at least one value.')
    }
    return write({ action: 'answer', card: getRequiredStringFlag(context.flags, 'card'), values })(
      context
    )
  },
  'bot google-setup done': write({ action: 'done' }),
  'bot google-setup fail': (context) =>
    write({ action: 'fail', error: getRequiredStringFlag(context.flags, 'error') })(context)
}
