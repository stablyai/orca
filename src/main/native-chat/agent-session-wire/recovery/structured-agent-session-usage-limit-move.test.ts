import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { LegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { usageLimitStopOf } from '../../../../shared/bots/bot-usage-limit-stop'
import { StructuredAgentSessionUsageLimitContinue } from './structured-agent-session-usage-limit-continue'

const HIT: LegacyAgentSessionAccountHome = { variable: 'CODEX_HOME', path: '/homes/spent' }
const NEXT: LegacyAgentSessionAccountHome = { variable: 'CODEX_HOME', path: '/homes/next' }
const ENDED = 1_000_000
const SWITCHED = ENDED + 60_000
const RESET = SWITCHED + 3_600_000
const CUT = { turnItemId: 'turn-1', resetsAt: RESET, turnEndedAt: ENDED, chain: 0, fence: 3 }

const reading = (usedPercent: number, resetsAt: number): ProviderRateLimits => ({
  provider: 'codex',
  session: { usedPercent, resetsAt, windowMinutes: 300, resetDescription: null },
  weekly: null,
  updatedAt: SWITCHED + 5_000,
  error: null,
  status: 'ok'
})

/** A loaded chat that is not open, limited on HIT, on a host whose account selection is `current`. */
function unopenedChat(current: LegacyAgentSessionAccountHome) {
  const world: {
    current: LegacyAgentSessionAccountHome
    reading: ProviderRateLimits | null
    witness: string
    now: number
    launchHomeReads: number
    refreshes: number
  } = {
    current,
    reading: null,
    witness: 'selection-1',
    now: SWITCHED,
    launchHomeReads: 0,
    refreshes: 0
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reads only these fields
  const deps = {
    sessions: new Map([['chat', {}]]),
    readSavedCut: async () => null,
    readLoadedCut: async () => CUT,
    serialize: (_id: string, run: () => Promise<unknown>) => run(),
    send: async () => ({ ok: true }),
    publish: () => {},
    now: () => world.now,
    host: {
      logger: { warn: () => {} },
      launchAccountHome: async () => {
        world.launchHomeReads += 1
        return world.current
      },
      store: {
        hostId: 'host',
        // Nothing is open: no tab, no background chat.
        listVisibleSessionIds: () => [],
        listBackgroundSessionIds: () => [],
        isSessionTabVisible: () => false,
        isSessionInBackground: () => false,
        cancelUsageLimitContinue: async () => {},
        getRecord: () => ({
          provider: 'codex',
          location: { wslDistro: null, executionHostId: 'host', workspaceId: 'ws' },
          launchedAccount: { fence: 3, accountHome: HIT },
          lease: { runtimeFence: 3 }
        })
      },
      usageLimitAutoContinue: {
        isEnabled: () => true,
        isWorkspaceAsleep: () => false,
        accountWitness: () => world.witness,
        accountUsage: async (_provider: string, home: LegacyAgentSessionAccountHome) => ({
          scope: home.path,
          account: {
            key: home.path,
            read: () => world.reading,
            refresh: () => {
              world.refreshes += 1
              return true
            }
          }
        })
      }
    }
  } as unknown as ConstructorParameters<typeof StructuredAgentSessionUsageLimitContinue>[0]
  const continuer = new StructuredAgentSessionUsageLimitContinue(deps)
  const published = () => continuer.readState('chat', CUT)
  const stop = () => usageLimitStopOf({ usageLimitContinue: published() }, world.now)
  return { world, continuer, published, stop }
}

describe('a usage-limit stop after the chat moved to another account', () => {
  it('keeps the stop while the new account has not been read since the move', async () => {
    const chat = unopenedChat(NEXT)
    await chat.continuer.tick()
    chat.world.now = SWITCHED + 10_000
    expect(chat.published()).toMatchObject({ resetsAt: RESET, state: 'off' })
    expect(chat.published()?.continueAt).toBeUndefined()
    expect(chat.stop()).toEqual({ at: RESET, auto: false })
    // Orca asks for that reading rather than waiting on an idle poller.
    expect(chat.world.refreshes).toBeGreaterThan(0)
  })

  it('drops the stop once the new account is read with room', async () => {
    const chat = unopenedChat(NEXT)
    await chat.continuer.tick()
    chat.world.reading = reading(10, SWITCHED + 3 * 3_600_000)
    chat.world.now = SWITCHED + 10_000
    expect(chat.published()).toMatchObject({ resetsAt: RESET, continueAt: SWITCHED })
    expect(chat.stop()).toBeNull()
  })

  it("shows the new account's reset once it is read spent", async () => {
    const chat = unopenedChat(NEXT)
    await chat.continuer.tick()
    const nextReset = SWITCHED + 1_800_000
    chat.world.reading = reading(100, nextReset)
    chat.world.now = SWITCHED + 10_000
    expect(chat.published()).toMatchObject({ resetsAt: RESET, continueAt: nextReset })
    expect(chat.stop()).toEqual({ at: nextReset, auto: false })
  })

  it('keeps the reset it hit when the chat never moved', async () => {
    const chat = unopenedChat(HIT)
    chat.world.reading = reading(10, SWITCHED + 3 * 3_600_000)
    await chat.continuer.tick()
    expect(chat.published()?.continueAt).toBeUndefined()
    expect(chat.stop()).toEqual({ at: RESET, auto: false })
  })

  it('attributes a loaded chat that is not open once per account move, not every pass', async () => {
    const chat = unopenedChat(HIT)
    await chat.continuer.tick()
    await chat.continuer.tick()
    await chat.continuer.tick()
    expect(chat.world.launchHomeReads).toBe(1)
    expect(chat.published()?.continueAt).toBeUndefined()

    // The selection moves: the next pass attributes it again, once.
    chat.world.current = NEXT
    chat.world.witness = 'selection-2'
    chat.world.reading = reading(10, SWITCHED + 3 * 3_600_000)
    await chat.continuer.tick()
    await chat.continuer.tick()
    expect(chat.world.launchHomeReads).toBe(2)
    expect(chat.stop()).toBeNull()
  })
})
