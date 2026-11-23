import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleSetupRuns } from '../../../google/google-setup-runs'
import { googleSetupKeyBlocker } from '../../../../shared/google/google-setup-blocker'
import type { RpcContext } from '../core'

const state = vi.hoisted(() => ({ runs: null as unknown, offers: 0 }))
const BOT = { id: 'bot-1', name: 'Ada', google: true, chatSessionId: 'chat-1' }
const OLD_CLIENT = { clientId: 'old', projectId: 'home', source: 'imported', savedAt: 1 }

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
  botOfToken: () => ({ kind: 'bot', bot: BOT })
}))
vi.mock('../../../google/google-card-reach', () => ({ noWindowAnswersGoogleCards: () => false }))
vi.mock('../../../google/google-setup-chat-cards', () => ({
  writeGoogleSetupCards: () => [],
  rewriteGoogleSetupWaitingCard: () => {}
}))
vi.mock('./bots-connector-offer', () => ({
  postConnectorOffer: async () => {
    state.offers += 1
  }
}))

const { GOOGLE_SETUP_METHODS } = await import('./bots-google-setup')
const write = GOOGLE_SETUP_METHODS.find((method) => method.name === 'bots.googleSetup.write')!

const context = {
  runtime: {
    bots: { assertEnabled: () => {}, enabled: () => true, list: () => [BOT] },
    lookAround: { botOfLook: () => null }
  }
} as unknown as RpcContext

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-google-setup-start-'))
  state.runs = new GoogleSetupRuns(() => join(dir, 'runs.json'))
  state.offers = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('bots.googleSetup.write start with an app already here', () => {
  it('shows the Connect card without --new-app', async () => {
    const result = await write.handler({ botToken: 't', change: { action: 'start' } }, context)
    expect(result).toMatchObject({ routed: 'offer' })
    expect(state.offers).toBe(1)
    expect((state.runs as GoogleSetupRuns).get(BOT.id)).toBeNull()
  })

  it('starts a new-app run with --new-app, and the old key is not its key', async () => {
    const result = await write.handler(
      { botToken: 't', change: { action: 'start', newApp: true } },
      context
    )
    expect(state.offers).toBe(0)
    const run = (state.runs as GoogleSetupRuns).get(BOT.id)!
    expect(result).toMatchObject({ run: { id: run.id, state: 'running', newApp: true } })
    expect(googleSetupKeyBlocker(run, { client: OLD_CLIENT, accounts: [] } as never)).toMatchObject(
      { kind: 'no-key' }
    )
  })
})
