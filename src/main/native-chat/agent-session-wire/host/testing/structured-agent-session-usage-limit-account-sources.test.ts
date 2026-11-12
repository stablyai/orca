import { afterEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { appendRewindUsageLimitedTurn } from './structured-agent-session-rewind-usage-limit.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import {
  HOUR,
  fakeAccountSources,
  weekly,
  type FleetSources
} from './structured-agent-session-usage-limit-fleet.test-fixture'

/** The rig's cut resets a minute after it is written; its continue is due 15 s later. */
const DUE = NOW + 75_000
const HELD_UNTIL = DUE + 3 * HOUR
/** The queued rig's Claude chat home. */
const CLAUDE_HOME = '/private-fixture/claude'
const GATEWAY = { ANTHROPIC_BASE_URL: 'https://gateway.example.invalid' }

let rig: QueuedMessageTestRig | undefined
afterEach(async () => rig?.dispose())

/** A Claude chat launched through a gateway set only in the login-shell capture, so only that
 *  capture keeps it off its subscription. */
function gatewayOnlyInShell(settings: FleetSources['settings']): FleetSources {
  return {
    settings,
    shellEnv: { ...GATEWAY },
    shellRevision: 1,
    reading: { home: CLAUDE_HOME, provenance: 'system' },
    limits: weekly(100, HELD_UNTIL, DUE)
  }
}

/** A usage-limited Claude chat on the production sweep, host mutations and settlement, attributed
 *  through the production account sources over fake owners. */
async function claudeChat(sources: FleetSources) {
  await rig?.dispose()
  let clock = NOW
  let preparing: (() => void) | undefined
  const fake = fakeAccountSources(sources)
  const current = await createQueuedMessageTestRig({
    agent: 'claude',
    now: () => clock,
    usageLimitAutoContinue: {
      isEnabled: () => true,
      isWorkspaceAsleep: () => false,
      subscribe: () => () => {},
      ...fake.production
    }
  })
  rig = current
  const send = current.host.send
  // Runs once inside the next send, after the sweep admitted it and before the host's own check.
  current.host.send = (...args) => {
    const prepare = preparing
    preparing = undefined
    prepare?.()
    return send(...args)
  }
  await current.store.setSessionTabVisibility(SESSION, true)
  const journal = current.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  expect((await appendRewindUsageLimitedTurn(journal, clock)).resetsAt).toBe(DUE - 15_000)
  return {
    suspendNextShellRead: fake.suspendNextShellRead,
    prepareNextSend: (change: () => void) => {
      preparing = change
    },
    /** Runs one pass at `at`; the host-origin submissions the journal holds after it. */
    pass: async (at: number) => {
      clock = at
      await current.host.usageLimitContinue.tick()
      const snapshot = await current.host.journalSnapshot(SESSION)
      return snapshot.submissions.filter((submission) => submission.origin === 'host')
    },
    state: () => current.host.usageLimitContinue.readState(SESSION),
    /** The one continue a pass sent, carried through to an accepted settlement. */
    settle: async (sent: readonly { clientMessageId: string }[]) => {
      expect(sent).toHaveLength(1)
      const id = sent[0]!.clientMessageId
      await eventually(async () =>
        expect((await current.submission(id))?.handedOverAt).toBeDefined()
      )
      await current.settleAccepted(id, 'continued')
      expect((await current.submission(id))?.dispatchState).toBe('accepted')
    }
  }
}

it('refuses a send whose shell inheritance changed during preparation, then settles it once held and released', async () => {
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
    const chat = await claudeChat(sources)
    // A settings write replaces the snapshot while the send is being prepared.
    chat.prepareNextSend(() => {
      sources.settings = after
    })
    expect(await chat.pass(DUE)).toEqual([])
    expect(chat.state()).toMatchObject({ state: 'scheduled' })
    expect(await chat.pass(DUE + 61_000)).toEqual([])
    expect(chat.state()).toMatchObject({ state: 'scheduled', continueAt: HELD_UNTIL })
    sources.limits = weekly(0, null, HELD_UNTIL + 15_000)
    await chat.settle(await chat.pass(HELD_UNTIL + 15_000))
  }
})

it('never sends on an attribution whose sources moved while it resolved, then settles once stable', async () => {
  const variants: {
    initial: FleetSources
    /** While the pass resolves the chat. */
    first: (sources: FleetSources) => void
    /** While the send resolves it again, right before it would go. */
    second: (sources: FleetSources) => void
  }[] = [
    {
      // Only the cached shell capture moves, twice; settings never change.
      initial: gatewayOnlyInShell({}),
      first: (sources) => {
        sources.shellRevision = 2
      },
      second: (sources) => {
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
        reading: { home: '/private-fixture/previous', provenance: 'profile:previous' },
        limits: weekly(0, null, DUE)
      },
      first: (sources) => {
        sources.settings = {}
      },
      second: (sources) => {
        sources.reading = { home: CLAUDE_HOME, provenance: 'system' }
        sources.limits = weekly(100, HELD_UNTIL, DUE)
      }
    }
  ]
  for (const { initial, first, second } of variants) {
    const sources = initial
    const chat = await claudeChat(sources)
    const firstRead = chat.suspendNextShellRead()
    const pass = chat.pass(DUE)
    await firstRead.reached
    first(sources)
    const secondRead = chat.suspendNextShellRead()
    firstRead.release()
    // The send must resolve its moved sources again; a pass that ends first never did.
    const reached = await Promise.race([
      secondRead.reached.then(() => true),
      pass.then(() => false)
    ])
    expect(reached).toBe(true)
    second(sources)
    secondRead.release()
    expect(await pass).toEqual([])
    expect(chat.state()).toMatchObject({ state: 'scheduled' })
    expect(await chat.pass(DUE + 61_000)).toEqual([])
    expect(chat.state()).toMatchObject({ state: 'scheduled', continueAt: HELD_UNTIL })
    sources.limits = weekly(0, null, HELD_UNTIL + 15_000)
    await chat.settle(await chat.pass(HELD_UNTIL + 15_000))
  }
})
