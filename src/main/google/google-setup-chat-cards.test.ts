import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { GoogleSetupRun } from '../../shared/google/google-setup-run'
import { GoogleSetupRuns } from './google-setup-runs'
import { googleSetupCardsDue, rewriteGoogleSetupWaitingCard } from './google-setup-chat-cards'

const written = vi.hoisted((): string[] => [])
vi.mock('../bots/bot-chat-status-line', () => ({
  writeInChat: (_chat: string, body: { googleSetup: { card: string; copy?: number } }) =>
    written.push(`${body.googleSetup.card}#${body.googleSetup.copy ?? 0}`)
}))
const store = vi.hoisted((): { runs: GoogleSetupRuns | null } => ({ runs: null }))
vi.mock('./google-setup-runs', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  googleSetupRuns: () => store.runs
}))
const dir = mkdtempSync(join(tmpdir(), 'orca-google-setup-cards-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function run(overrides: Partial<GoogleSetupRun> = {}): GoogleSetupRun {
  return {
    id: 'run-1',
    botId: 'ivy',
    state: 'running',
    mode: 'do-it-for-me',
    steps: {},
    answers: {},
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides
  }
}

const due = (prev: GoogleSetupRun | null, next: GoogleSetupRun): string[] =>
  googleSetupCardsDue(prev, next).map((ref) => (ref.step ? `${ref.card}:${ref.step}` : ref.card))

const answer = (values: string[]) => ({ values, at: 2 })

describe('the setup cards a run change calls for', () => {
  it('opens the path card, asks for services and then shows progress', () => {
    const started = run()
    expect(due(null, started)).toEqual(['path'])

    const pathed = run({ answers: { path: answer(['guide-here']) }, mode: 'guide-here' })
    expect(due(started, pathed)).toEqual(['services'])
    const serviced = run({
      ...pathed,
      answers: { ...pathed.answers, services: answer(['gmail']) }
    })
    expect(due(pathed, serviced)).toEqual(['progress'])
    // Changing an answer writes nothing new; the card already shows it.
    expect(
      due(serviced, {
        ...serviced,
        answers: { ...serviced.answers, path: answer(['guide-browser']) }
      })
    ).toEqual([])
  })

  it('offers an account pick only for two or more signed-in accounts', () => {
    expect(due(run(), run({ accounts: ['a@x.com'] }))).toEqual([])
    expect(due(run(), run({ accounts: ['a@x.com', 'b@x.com'] }))).toEqual(['account'])
  })

  it('writes a step card when a step turns to the person, once', () => {
    const handed = run({
      steps: { publish: { status: 'needs-user', at: 2, note: 'Tick the box' } }
    })
    expect(due(run(), handed)).toEqual(['step:publish'])
    expect(due(handed, { ...handed, revision: 2 })).toEqual([])
    // In Guide me here the person's active step is theirs; in Do it for me it's the bot's.
    const active = { steps: { apis: { status: 'active' as const, at: 2 } } }
    expect(due(run({ mode: 'guide-here' }), run({ mode: 'guide-here', ...active }))).toEqual([
      'step:apis'
    ])
    expect(due(run(), run(active))).toEqual([])
  })

  it('asks for recovery when the key is missing and sign-in when a key is available', () => {
    const open = run({ steps: { client: { status: 'active', at: 2 } } })
    const missing = run({ ...open, keyMissed: { at: 3 } })
    expect(due(open, missing)).toEqual(['progress'])
    expect(due(missing, run({ steps: { client: { status: 'done', at: 4, by: 'bot' } } }))).toEqual([
      'connect'
    ])
    const imported = run({
      answers: { path: answer(['import']) },
      steps: { client: { status: 'skipped', at: 2 } }
    })
    expect(due(run(), imported)).toEqual(['connect'])
  })

  it('writes one card when a run finishes or fails, and none when cancelled or resumed', () => {
    const started = run()
    const done = run({ state: 'done' })
    const failed = run({ state: 'failed', lastError: 'quota' })
    expect(due(started, done)).toEqual(['connected'])
    expect(due(done, { ...done, revision: 2 })).toEqual([])
    expect(due(started, failed)).toEqual(['progress'])
    expect(due(failed, { ...failed, revision: 2 })).toEqual([])
    expect(due(failed, started)).toEqual([])
    expect(due(started, run({ state: 'cancelled' }))).toEqual([])
  })

  it("starts over after the owner's choices, which it keeps", () => {
    const kept = { path: answer(['do-it-for-me']), services: answer(['gmail']) }
    expect(due(run({ id: 'old' }), run({ id: 'new', answers: kept }))).toEqual(['progress'])
    expect(due(run({ id: 'old' }), run({ id: 'new', answers: { path: kept.path } }))).toEqual([
      'services'
    ])
    // A path never chosen asks again.
    expect(due(run({ id: 'old' }), run({ id: 'new', mode: 'unchosen', answers: kept }))).toEqual([
      'path'
    ])
  })
})

describe('the waiting card, written again at the bottom', () => {
  it('writes the card the owner must press once per run change, numbering each copy', () => {
    written.length = 0
    const runs = new GoogleSetupRuns(() => join(dir, 'runs.json'))
    store.runs = runs
    runs.apply('ivy', 'owner', { action: 'start', mode: 'do-it-for-me' })
    runs.apply('ivy', 'owner', { action: 'answer', card: 'step', values: ['done', 'client'] })
    rewriteGoogleSetupWaitingCard('chat', runs.get('ivy')!)
    // The bot asking again before anything changed adds no copy.
    rewriteGoogleSetupWaitingCard('chat', runs.get('ivy')!)
    runs.apply('ivy', 'owner', { action: 'answer', card: 'step', values: ['resume'] })
    rewriteGoogleSetupWaitingCard('chat', runs.get('ivy')!)
    expect(written).toEqual(['connect#0', 'connect#1'])
    // The run names the newest copy, so only that one acts wherever the chat is scrolled.
    expect(runs.get('ivy')?.cardCopies).toEqual({ connect: 1 })
  })
})
