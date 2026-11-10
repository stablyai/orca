import { expect, it } from 'vitest'
import { HOST_TEST_NOW as NOW } from './structured-agent-session-host-test-data'
import {
  FLEET_HOME,
  HOUR,
  usageLimitFleet,
  weekly,
  type FleetSources
} from './structured-agent-session-usage-limit-fleet.test-fixture'

const WEEKLY_RESET = NOW + 3 * HOUR
const GATEWAY = { ANTHROPIC_BASE_URL: 'https://gateway.example.invalid' }

/** A Claude chat whose subscription week is spent, launched through a gateway set only in the
 *  login-shell capture, so only that capture keeps the launch off the subscription. */
function gatewayOnlyInShell(settings: FleetSources['settings']): FleetSources {
  return {
    settings,
    shellEnv: { ...GATEWAY },
    shellRevision: 1,
    reading: { home: FLEET_HOME, provenance: 'system' },
    limits: weekly(100, WEEKLY_RESET, NOW)
  }
}

it('refuses a send whose shell inheritance changed during preparation, then holds it on the subscription', async () => {
  const variants = [
    {
      before: { nativeChatInheritShellEnvironment: true },
      after: { nativeChatInheritShellEnvironment: false }
    },
    {
      before: {
        nativeChatInheritShellEnvironment: false,
        nativeChatShellEnvironmentVariables: ['ANTHROPIC_BASE_URL']
      },
      after: { nativeChatInheritShellEnvironment: false, nativeChatShellEnvironmentVariables: [] }
    }
  ]
  for (const { before, after } of variants) {
    const sources = gatewayOnlyInShell(before)
    const fleet = usageLimitFleet({
      count: 1,
      provider: 'claude',
      now: NOW,
      sources,
      // A settings write replaces the snapshot while the send is being prepared.
      preparing: () => {
        sources.settings = after
      }
    })
    await fleet.pass(NOW)
    expect(fleet.dispatched).toEqual([])
    expect(fleet.state()).toMatchObject({ state: 'scheduled' })
    await fleet.pass(NOW + 61_000)
    expect(fleet.dispatched).toEqual([])
    expect(fleet.state()).toMatchObject({ state: 'scheduled', continueAt: WEEKLY_RESET })
    sources.limits = weekly(0, null, WEEKLY_RESET + 15_000)
    await fleet.pass(WEEKLY_RESET + 15_000)
    expect(fleet.dispatched).toEqual(['chat-0'])
  }
})

it('never sends on an attribution whose sources moved while a queued send resolved it', async () => {
  const variants: {
    initial: FleetSources
    afterFirstDispatch: (sources: FleetSources) => void
    whileResolving: (sources: FleetSources) => void
  }[] = [
    {
      // Only the cached shell capture moves, twice; settings never change.
      initial: gatewayOnlyInShell({}),
      afterFirstDispatch: (sources) => {
        sources.shellRevision = 2
      },
      whileResolving: (sources) => {
        sources.shellEnv = {}
        sources.shellRevision = 3
      }
    },
    {
      // The selection moves to this home; its own spent reading lands mid-resolution.
      initial: {
        settings: {},
        shellEnv: {},
        shellRevision: 1,
        reading: { home: '/orca-usage-limit-fleet/previous', provenance: 'profile:previous' },
        limits: weekly(0, null, NOW)
      },
      afterFirstDispatch: (sources) => {
        sources.settings = {}
      },
      whileResolving: (sources) => {
        sources.reading = { home: FLEET_HOME, provenance: 'system' }
        sources.limits = weekly(100, WEEKLY_RESET, NOW)
      }
    }
  ]
  for (const { initial, afterFirstDispatch, whileResolving } of variants) {
    const sources = initial
    let suspended: (handle: { release: () => void }) => void = () => {}
    const resolving = new Promise<{ release: () => void }>((resolve) => (suspended = resolve))
    const fleet = usageLimitFleet({
      count: 2,
      provider: 'claude',
      now: NOW,
      sources,
      dispatching: (id) => {
        if (id === 'chat-0' && fleet.dispatched.length === 1) {
          afterFirstDispatch(sources)
          const handle = fleet.suspendNextShellRead()
          void handle.reached.then(() => suspended(handle))
        }
      }
    })
    const pass = fleet.pass(NOW)
    // The second chat's send must resolve its moved sources again; a pass that ends first never did.
    const handle = await Promise.race([resolving, pass.then(() => null)])
    expect(handle).not.toBeNull()
    whileResolving(sources)
    handle?.release()
    await pass
    expect(fleet.dispatched).toEqual(['chat-0'])
    expect(fleet.state('chat-1')).toMatchObject({ state: 'scheduled' })
    await fleet.pass(NOW + 61_000)
    expect(fleet.state('chat-1')).toMatchObject({ state: 'scheduled', continueAt: WEEKLY_RESET })
    expect(fleet.dispatched).toEqual(['chat-0'])
    sources.limits = weekly(0, null, WEEKLY_RESET + 15_000)
    await fleet.pass(WEEKLY_RESET + 15_000)
    expect(fleet.dispatched).toContain('chat-1')
  }
})

it('shares attribution for queued continuations blocked by a newer reading at N and 10N', async () => {
  for (const settingsChange of [false, true]) {
    for (const count of [300, 3000]) {
      const sources: FleetSources = {
        settings: {},
        shellEnv: {},
        shellRevision: 1,
        reading: { home: FLEET_HOME, provenance: 'system' },
        limits: weekly(0, null, NOW)
      }
      const fleet = usageLimitFleet({
        count,
        provider: 'codex',
        now: NOW,
        sources,
        // A reading that spends the week lands during the first dispatch, with or without a
        // settings write that moves every remaining chat's sources at once.
        dispatching: () => {
          sources.limits = weekly(100, WEEKLY_RESET, NOW)
          if (settingsChange) {
            sources.settings = {}
          }
        }
      })
      await fleet.pass(NOW)
      expect(fleet.dispatched).toEqual(['chat-0'])
      expect(fleet.state(`chat-${count - 1}`)).toMatchObject({
        state: 'scheduled',
        continueAt: WEEKLY_RESET
      })
      expect(fleet.calls).toEqual(
        settingsChange ? { launchHome: 2, reader: 2 } : { launchHome: 1, reader: 1 }
      )
    }
  }
})
