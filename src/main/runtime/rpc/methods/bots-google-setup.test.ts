import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleSetupRuns } from '../../../google/google-setup-runs'
import { googleSetupKeyBlocker } from '../../../../shared/google/google-setup-blocker'
import type { GoogleClientView } from '../../../../shared/google/google-client-config'
import type { RpcContext } from '../core'

const state = vi.hoisted((): { runs: GoogleSetupRuns | null; offers: number; lines: string[] } => ({
  runs: null,
  offers: 0,
  lines: []
}))
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
    accounts: async () => [],
    clientCheck: async () => null
  })
}))
vi.mock('../../../bots/bot-of-caller', () => ({
  BOT_TOKEN_ENDED: 'ended',
  botOfToken: (_runtime: unknown, token?: string) =>
    token ? { kind: 'bot', bot: BOT } : { kind: 'owner' }
}))
vi.mock('../../../google/google-card-reach', () => ({ noWindowAnswersGoogleCards: () => false }))
vi.mock('../../../google/google-setup-chat-cards', () => ({
  writeGoogleSetupCards: () => [],
  rewriteGoogleSetupWaitingCard: () => {}
}))
vi.mock('../../../bots/bot-chat-session', () => ({
  runtimeBotChats: () => ({
    sendToChat: async (_botId: string, line: string) => {
      state.lines.push(line)
      return { sessionId: BOT.chatSessionId }
    }
  })
}))
vi.mock('./bots-connector-offer', () => ({
  postConnectorOffer: async () => {
    state.offers += 1
  }
}))

const { GOOGLE_SETUP_METHODS } = await import('./bots-google-setup')
const [, write, , start] = GOOGLE_SETUP_METHODS
if (write.name !== 'bots.googleSetup.write' || start.name !== 'bots.googleSetup.start') {
  throw new Error('bots.googleSetup.write or start moved')
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
  state.lines = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('bots.googleSetup.write start with an app already here', () => {
  it('shows the Connect card without --new-app', async () => {
    const result = await write.handler({ botToken: 't', change: { action: 'start' } }, context)
    expect(result).toMatchObject({ routed: 'offer' })
    expect(state.offers).toBe(1)
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
