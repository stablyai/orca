import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleSetupRuns } from '../../../google/google-setup-runs'
import { googleSetupKeyBlocker } from '../../../../shared/google/google-setup-blocker'
import {
  googleSetupChoiceLocked,
  googleSetupConnectOpen,
  googleSetupShownStepStatus,
  googleSetupStepCardView
} from '../../../../shared/google/google-setup-card-view'
import type { GoogleClientView } from '../../../../shared/google/google-client-config'
import type { GoogleAccountView } from '../../../../shared/google/google-connect-types'
import type { RpcContext } from '../core'
import type { GoogleSetupRun } from '../../../../shared/google/google-setup-run'
import type * as ChatCards from '../../../google/google-setup-chat-cards'

const state = vi.hoisted(
  (): {
    runs: GoogleSetupRuns | null
    offers: number
    shown: boolean
    lines: string[]
    accounts: GoogleAccountView[]
    cards: string[]
    duringCheck: (() => void) | null
  } => ({
    runs: null,
    offers: 0,
    shown: true,
    lines: [],
    accounts: [],
    cards: [],
    duringCheck: null
  })
)
const BOT = { id: 'bot-1', name: 'Ada', google: true, chatSessionId: 'chat-1' }
const OLD_CLIENT: GoogleClientView = {
  clientId: 'old',
  projectId: 'home',
  source: 'imported',
  savedAt: 1
}

vi.mock('../../../google/google-setup-runs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  googleSetupRuns: () => state.runs
}))
vi.mock('../../../google/google-connect', () => ({
  getGoogleConnect: () => ({
    client: async () => OLD_CLIENT,
    accounts: async () => state.accounts,
    checkAccounts: async () => state.accounts,
    checkClient: async () => null,
    clientCheck: async () => {
      state.duringCheck?.()
      return null
    }
  })
}))
vi.mock('../../../bots/bot-of-caller', () => ({
  BOT_TOKEN_ENDED: 'ended',
  botOfToken: (_runtime: unknown, token?: string) =>
    token ? { kind: 'bot', bot: BOT } : { kind: 'owner' }
}))
vi.mock('../../../google/google-card-reach', () => ({ noWindowAnswersGoogleCards: () => false }))
vi.mock('../../../google/google-setup-chat-cards', async (importOriginal) => {
  const real = await importOriginal<typeof ChatCards>()
  return {
    ...real,
    // The cards a change calls for, without a chat to write them in.
    writeGoogleSetupCards: (...[, prev, next]: Parameters<typeof real.writeGoogleSetupCards>) => {
      const due = real.googleSetupCardsDue(prev, next)
      state.cards.push(...due.map((ref) => ref.card))
      return due
    },
    rewriteGoogleSetupWaitingCard: () => {}
  }
})
vi.mock('../../../bots/bot-chat-session', () => ({
  runtimeBotChats: () => ({
    sendToChat: async (_botId: string, line: string) => {
      state.lines.push(line)
      return { sessionId: BOT.chatSessionId }
    }
  })
}))
vi.mock('./bots-connector-offer', () => ({
  offerConnectorCard: async (...args: [unknown, unknown, unknown, unknown, string]) => {
    state.offers += 1
    return {
      shown: state.shown,
      message: state.shown ? `${args[4]} (with note)` : 'No card was shown.'
    }
  }
}))

const { GOOGLE_SETUP_METHODS } = await import('./bots-google-setup')
const [read, write, , start] = GOOGLE_SETUP_METHODS
if (
  read.name !== 'bots.googleSetup.read' ||
  write.name !== 'bots.googleSetup.write' ||
  start.name !== 'bots.googleSetup.start'
) {
  throw new Error('bots.googleSetup.read, write or start moved')
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the write handler reads only bots and lookAround here.
const context = {
  runtime: {
    bots: { assertEnabled: () => {}, enabled: () => true, list: () => [BOT] },
    lookAround: { botOfLook: () => null }
  }
} as unknown as RpcContext

let dir: string
let runs: GoogleSetupRuns
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-google-setup-start-'))
  runs = new GoogleSetupRuns(() => join(dir, 'runs.json'))
  state.runs = runs
  state.offers = 0
  state.shown = true
  state.lines = []
  state.duringCheck = null
  state.accounts = []
  state.cards = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('bots.googleSetup.write start with an app already here', () => {
  it('shows the Connect card without --new-app', async () => {
    const result = await write.handler({ botToken: 't', change: { action: 'start' } }, context)
    expect(result).toMatchObject({ routed: 'offer' })
    // The card's answer, with any thread note, not the bare ask.
    expect(result).toMatchObject({ message: expect.stringMatching(/\(with note\)$/) })
    expect(state.offers).toBe(1)
    expect(runs.get(BOT.id)).toBeNull()
  })

  it('fails rather than routing to a card that was not written', async () => {
    state.shown = false
    await expect(
      write.handler({ botToken: 't', change: { action: 'start' } }, context)
    ).rejects.toThrow('No card was shown.')
    expect(runs.get(BOT.id)).toBeNull()
  })

  it('starts a new-app run with --new-app, and the old key is not its key', async () => {
    const result = await write.handler(
      { botToken: 't', change: { action: 'start', newApp: true } },
      context
    )
    expect(state.offers).toBe(0)
    const run = runs.get(BOT.id)
    if (!run) {
      throw new Error('no run')
    }
    expect(result).toMatchObject({ run: { id: run.id, state: 'running', newApp: true } })
    expect(googleSetupKeyBlocker(run, { client: OLD_CLIENT, accounts: [] })).toMatchObject({
      kind: 'no-key'
    })
  })

  it('keeps a running setup as is with --new-app, only marking it', async () => {
    runs.apply(BOT.id, 'owner', { action: 'start' })
    const answered = runs.apply(BOT.id, 'owner', {
      action: 'answer',
      card: 'path',
      values: ['do-it-for-me']
    })
    await write.handler({ botToken: 't', change: { action: 'start', newApp: true } }, context)
    expect(runs.get(BOT.id)).toMatchObject({
      id: answered.id,
      mode: answered.mode,
      answers: answered.answers,
      startedAt: answered.startedAt,
      newApp: true
    })
  })
})

describe('bots.googleSetup.start from Orca with newApp', () => {
  it('starts a new-app run in the bot chat, and the old key is not its key', async () => {
    const { run } = await start.handler({ botId: BOT.id, from: 'settings', newApp: true }, context)
    expect(run).toMatchObject({ state: 'running', mode: 'unchosen', newApp: true })
    expect(googleSetupKeyBlocker(run, { client: OLD_CLIENT, accounts: [] })).toMatchObject({
      kind: 'no-key'
    })
    expect(state.lines).toEqual([
      'Setup of a new Google app started by your owner (from settings). Run `orca bot google-setup show` and carry on from there.'
    ])
  })

  it('marks a running setup rather than restarting it', async () => {
    runs.apply(BOT.id, 'owner', { action: 'start' })
    const answered = runs.apply(BOT.id, 'owner', {
      action: 'answer',
      card: 'path',
      values: ['do-it-for-me']
    })
    const { run } = await start.handler({ botId: BOT.id, from: 'chat', newApp: true }, context)
    expect(run).toMatchObject({
      id: answered.id,
      mode: answered.mode,
      answers: answered.answers,
      newApp: true
    })
    expect(state.lines).toHaveLength(1)
  })

  it('starts over a running setup that imported the team file', async () => {
    runs.apply(BOT.id, 'owner', { action: 'start' })
    const imported = runs.apply(BOT.id, 'owner', {
      action: 'answer',
      card: 'path',
      values: ['import']
    })
    const { run } = await start.handler({ botId: BOT.id, from: 'settings', newApp: true }, context)
    expect(run.id).not.toBe(imported.id)
    expect(run).toMatchObject({ state: 'running', newApp: true, steps: {}, answers: {} })
  })

  it('returns to a running new-app setup without telling the bot again', async () => {
    const first = await start.handler({ botId: BOT.id, from: 'settings', newApp: true }, context)
    const again = await start.handler({ botId: BOT.id, from: 'settings', newApp: true }, context)
    expect(again.run).toEqual(first.run)
    expect(state.lines).toHaveLength(1)
  })
})

describe('Stop setup', () => {
  const waitingOnPublish = (): void => {
    runs.apply(BOT.id, 'owner', { action: 'start' })
    runs.apply(BOT.id, 'owner', { action: 'answer', card: 'path', values: ['guide-browser'] })
    runs.apply(BOT.id, 'bot', { action: 'need-user', step: 'publish', note: 'Click Publish app.' })
  }

  it('lets the owner stop a run, which locks its step card', async () => {
    waitingOnPublish()
    await write.handler({ botId: BOT.id, change: { action: 'cancel' } }, context)
    const run = runs.get(BOT.id)
    if (!run) {
      throw new Error('no run')
    }
    expect(run.state).toBe('cancelled')
    expect(googleSetupStepCardView(run, 'publish', true)).toMatchObject({
      acts: false,
      ended: true
    })
    expect(googleSetupShownStepStatus(run, 'publish')).toBe('pending')
    // Unanswered choice cards and the sign-in card take no clicks either.
    expect(googleSetupChoiceLocked(run, false, false)).toBe(true)
    expect(googleSetupConnectOpen(run)).toBe(false)
    // A second Stop (a double click) is a no-op, not an error.
    await write.handler({ botId: BOT.id, change: { action: 'cancel' } }, context)
    expect(runs.get(BOT.id)).toEqual(run)
    await expect(
      write.handler(
        { botToken: 't', change: { action: 'step', step: 'client', status: 'active' } },
        context
      )
    ).rejects.toThrow('Your owner stopped this Google setup.')
    await expect(
      write.handler(
        { botToken: 't', change: { action: 'step', step: 'client', status: 'done' } },
        context
      )
    ).rejects.toThrow('Your owner stopped this Google setup.')
  })

  it('leaves a newer run alone when a late Stop names the one it replaced', async () => {
    waitingOnPublish()
    const shown = runs.get(BOT.id)?.id
    await write.handler({ botId: BOT.id, change: { action: 'cancel', runId: shown } }, context)
    const fresh = runs.apply(BOT.id, 'owner', { action: 'start' })
    await write.handler({ botId: BOT.id, change: { action: 'cancel', runId: shown } }, context)
    expect(runs.get(BOT.id)).toEqual(fresh)
  })

  it("refuses a bot's stop", async () => {
    waitingOnPublish()
    await expect(
      write.handler({ botToken: 't', change: { action: 'cancel' } }, context)
    ).rejects.toThrow('Only your owner can stop the setup.')
    expect(runs.get(BOT.id)?.state).toBe('running')
  })

  it('drops an agent write when the owner stops and restarts the run during its checks', async () => {
    waitingOnPublish()
    runs.apply(BOT.id, 'bot', { action: 'step', step: 'client', status: 'active' })
    state.duringCheck = () => {
      state.duringCheck = null
      runs.apply(BOT.id, 'owner', { action: 'cancel' })
      runs.apply(BOT.id, 'owner', { action: 'start' })
    }
    const stopped = runs.get(BOT.id)?.id
    await expect(
      write.handler(
        { botToken: 't', change: { action: 'step', step: 'client', status: 'done' } },
        context
      )
    ).rejects.toThrow()
    const fresh = runs.get(BOT.id)
    expect(fresh?.id).not.toBe(stopped)
    expect(fresh).toMatchObject({ state: 'running', steps: {} })
    expect(fresh?.keyMissed).toBeUndefined()
  })
})

describe('a step handed to the owner that they finished outside its card', () => {
  const account = (state: 'ready' | 'api-disabled'): GoogleAccountView => ({
    email: 'dana@acme.com',
    status: 'connected',
    connectedAt: 5,
    services: [
      { service: 'gmail', state: 'ready' },
      { service: 'calendar', state }
    ]
  })
  // A run saved by an earlier build: publish handed to the owner, who published in Google Cloud and
  // signed in, so only that step's Done holds it.
  const saveStuckRun = (
    steps: GoogleSetupRun['steps'] = {},
    fields: Partial<GoogleSetupRun> = {}
  ) =>
    writeFileSync(
      join(dir, 'runs.json'),
      JSON.stringify({
        runs: {
          [BOT.id]: {
            id: 'run-1',
            botId: BOT.id,
            state: 'running',
            mode: 'guide-browser',
            steps: {
              account: { status: 'done', by: 'user', at: 2 },
              project: { status: 'done', by: 'user', at: 2 },
              apis: { status: 'done', by: 'user', at: 2 },
              branding: { status: 'done', by: 'user', at: 2 },
              links: { status: 'done', by: 'user', at: 2 },
              publish: { status: 'needs-user', at: 3, note: 'Press Publish app.' },
              client: { status: 'done', by: 'user', at: 4 },
              connect: { status: 'done', by: 'user', at: 5 },
              ...steps
            },
            account: 'dana@acme.com',
            services: ['gmail', 'calendar'],
            answers: {},
            startedAt: 1,
            updatedAt: 5,
            revision: 9,
            ...fields
          }
        }
      })
    )

  it('finishes an old stuck run on the next read once every chosen service is ready', async () => {
    saveStuckRun()
    state.accounts = [account('ready')]
    const result = await read.handler({ botId: BOT.id }, context)
    expect(result.blocker).toBeNull()
    expect(runs.get(BOT.id)).toMatchObject({
      state: 'done',
      steps: { publish: { status: 'done', note: expect.stringContaining('outside the card') } }
    })
    expect(runs.get(BOT.id)?.steps.publish?.by).toBeUndefined()
    await read.handler({ botId: BOT.id }, context)
    expect(state.cards).toEqual(['connected'])
  })

  it('records the step but keeps running while another step is left', async () => {
    saveStuckRun({ links: { status: 'active', at: 2 } }, { personStep: 'publish' })
    state.accounts = [account('ready')]
    await read.handler({ botId: BOT.id }, context)
    const run = runs.get(BOT.id)
    expect(run).toMatchObject({ state: 'running', steps: { publish: { status: 'done' } } })
    expect(run?.personStep).toBeUndefined()
    expect(state.cards).toEqual([])
  })

  it('counts a sign-in made outside the Connect card through this setup key', async () => {
    saveStuckRun({ connect: undefined })
    state.accounts = [{ ...account('ready'), app: { clientId: OLD_CLIENT.clientId } }]
    await read.handler({ botId: BOT.id }, context)
    expect(runs.get(BOT.id)).toMatchObject({
      state: 'done',
      steps: { connect: { status: 'done' } }
    })
  })

  it('ignores a sign-in through another app', async () => {
    saveStuckRun({ connect: undefined })
    state.accounts = [{ ...account('ready'), app: { clientId: 'other' } }]
    await read.handler({ botId: BOT.id }, context)
    expect(runs.get(BOT.id)).toMatchObject({
      state: 'running',
      steps: { publish: { status: 'needs-user' } }
    })
    expect(runs.get(BOT.id)?.steps.connect).toBeUndefined()
  })

  it("takes the bot's done and a late Done card answer once Orca finished the run", async () => {
    saveStuckRun()
    state.accounts = [account('ready')]
    await read.handler({ botId: BOT.id }, context)
    const finished = runs.get(BOT.id)
    const result = await write.handler({ botToken: 't', change: { action: 'done' } }, context)
    expect(result).toMatchObject({ run: { state: 'done', revision: finished?.revision } })
    expect(
      runs.apply(BOT.id, 'owner', { action: 'answer', card: 'step', values: ['done', 'connect'] })
    ).toEqual(finished)
    expect(state.cards).toEqual(['connected'])
  })

  it("lets the bot's done finish it", async () => {
    saveStuckRun()
    state.accounts = [account('ready')]
    const result = await write.handler({ botToken: 't', change: { action: 'done' } }, context)
    expect(result).toMatchObject({ run: { state: 'done' }, blocker: null })
  })

  it('keeps waiting on the owner while a chosen service is not ready', async () => {
    saveStuckRun()
    state.accounts = [account('api-disabled')]
    await read.handler({ botId: BOT.id }, context)
    await expect(
      write.handler({ botToken: 't', change: { action: 'done' } }, context)
    ).rejects.toThrow()
    expect(runs.get(BOT.id)).toMatchObject({
      state: 'running',
      steps: { publish: { status: 'needs-user' } }
    })
  })

  it('never lets the bot record it', () => {
    saveStuckRun()
    expect(() =>
      runs.apply(BOT.id, 'bot', { action: 'finished-outside', steps: ['publish'] })
    ).toThrow()
  })
})
