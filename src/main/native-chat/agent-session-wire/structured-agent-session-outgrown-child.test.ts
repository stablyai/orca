import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { acquiredAgentSessionAccount } from '../../../shared/agent-session-acquired-account'
import { agentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { installClaudeProfileRouter } from '../../claude-accounts/claude-profile-installed-router'
import {
  ClaudeProfileRouter,
  type ClaudeProfileRouterSettings
} from '../../claude-accounts/claude-profile-router'
import type { ClaudeProfileSetupReport } from '../../claude-accounts/claude-profile-setup'
import { prepareClaudeReceivingAccount } from '../../claude/claude-receiving-account'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/claude-structured-agent-definition'
import { resolveStructuredClaudeAccountHomePath } from '../../runtime/structured-agent-account-home'
import { createReceivingAccountFixture } from './structured-agent-session-receiving-account.test-support'
import { structuredAgentSessionReceivingAccount } from './structured-agent-session-receiving-account'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  acceptedDispatch,
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  IDLE_MS,
  restTestSend,
  sweepOnce,
  sweepTicks,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { hostTestAttachParams } from './structured-agent-session-host-test-data'
import {
  retireOutgrownStructuredAgentSessionChild,
  structuredAgentSessionChildReportedSignedOut
} from './structured-agent-session-outgrown-child'
import type { AgentChatPermissionChoice } from '../../../shared/agent-chat-permission-mode'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import type {
  AgentJournalItemBody,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { JournalItemLinkageVisitor } from '../agent-session-journal/journal-store-contracts'
import type { LegacyAgentSessionAccountHome } from '../../../shared/agent-session-account-home'

const accountHome = (path: string): LegacyAgentSessionAccountHome => ({
  variable: 'CODEX_HOME',
  path
})

describe('a send after the account was switched', () => {
  let rig: RestTestRig
  let selected = accountHome('/accounts/a')

  beforeEach(async () => {
    selected = accountHome('/accounts/a')
    rig = await createRestTestRig({ launchAccountHome: async () => selected })
    const acquire = rig.adapter.acquire.getMockImplementation()
    if (!acquire) {
      throw new Error('the rig acquires through a mock implementation')
    }
    rig.adapter.acquire.mockImplementation(async (request) => ({
      ...(await acquire(request)),
      accountHome: selected
    }))
  })

  afterEach(async () => {
    await rig.dispose()
  })

  const fence = () => rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1

  it('goes to a new agent on the new account, and that agent is kept for the sends after it', async () => {
    await foundRestTestChat(rig)
    expect((await rig.host.send(CALLER, restTestSend('on a', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)

    selected = accountHome('/accounts/b')
    expect((await rig.host.send(CALLER, restTestSend('on b', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(3))
    expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION, undefined)
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)

    expect((await rig.host.send(CALLER, restTestSend('still b', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(4))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
  })
})

describe('a send while the selected account folder is not set up yet', () => {
  const PROVIDER = 'provider-setup-boundary'
  const roots: string[] = []
  let rig: RestTestRig
  let router: ClaudeProfileRouter
  let settings: ClaudeProfileRouterSettings
  let setup: {
    resolve: (report: ClaudeProfileSetupReport) => void
    reject: (error: Error) => void
    promise: Promise<ClaudeProfileSetupReport>
  }
  const home = (id: string) => router.accountHome(id)
  const ready = (id: string) => {
    mkdirSync(home(id), { recursive: true })
    writeFileSync(join(dirname(home(id)), 'profile.json'), '{}')
  }

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-account-setup-'))
    roots.push(root)
    settings = {
      claudeManagedAccounts: [],
      activeClaudeManagedAccountId: 'a',
      activeClaudeManagedAccountIdsByRuntime: undefined,
      agentStatusHooksEnabled: false,
      disabledTuiAgents: []
    }
    let resolve!: (report: ClaudeProfileSetupReport) => void
    let reject!: (error: Error) => void
    const promise = new Promise<ClaudeProfileSetupReport>((res, rej) => {
      resolve = res
      reject = rej
    })
    promise.catch(() => {})
    setup = { resolve, reject, promise }
    router = new ClaudeProfileRouter({
      getSettings: () => settings,
      dataRoot: root,
      userHome: join(root, 'personal'),
      env: {},
      runSetup: () => setup.promise
    })
    installClaudeProfileRouter(router)
    ready('a')
    rig = await createRestTestRig({
      // The production resolver hop: only dispatch identity skips the availability check.
      launchAccountHome: async (_record, purpose) =>
        agentSessionAccountHome(
          CLAUDE_STRUCTURED_AGENT,
          resolveStructuredClaudeAccountHomePath({
            launchEnv: {},
            wslDistro: null,
            ...(purpose === 'identity' ? { purpose } : {}),
            getClaudeConfigDirectory: () => router.systemDefaultHome()
          })
        )
    })
    const base = rig.adapter.acquire.getMockImplementation()
    if (!base) {
      throw new Error('the rig acquires through a mock implementation')
    }
    rig.adapter.acquire.mockImplementation(async (input) => {
      // The real router prepares the selected account, joining or failing its setup, as a launch does.
      const recipe = await prepareClaudeReceivingAccount(router, {}, home('a'), input.accountRecipe)
      const acquired = await base(input)
      if (!acquired.link) {
        throw new Error('the rig acquisition always links a provider handle')
      }
      return {
        ...acquired,
        accountHome: agentSessionAccountHome(CLAUDE_STRUCTURED_AGENT, recipe.home),
        accountRecipe: recipe,
        link: { ...acquired.link, handle: claudeProviderHandle(PROVIDER, null) }
      }
    })
    const attached = await rig.host.attach(
      CALLER,
      hostTestAttachParams(null, {
        provider: 'claude',
        agent: 'claude',
        accountHome: agentSessionAccountHome(CLAUDE_STRUCTURED_AGENT, home('a')),
        providerHandle: { kind: 'claude', sessionId: PROVIDER, leafUuid: null }
      })
    )
    expect(attached.ok).toBe(true)
    await rig.store.setSessionTabVisibility(SESSION, true)
  })

  afterEach(async () => {
    await rig.dispose()
    installClaudeProfileRouter(undefined)
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  })

  const fence = () => rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1
  const send = async (text: string) => {
    const sent = await rig.host.send(CALLER, restTestSend(text, fence()))
    expect(sent.ok).toBe(true)
    return sent.ok ? sent.value.clientMessageId : ''
  }
  const submission = async (id: string) =>
    (await rig.host.journalSnapshot(SESSION)).submissions.find(
      (entry) => entry.clientMessageId === id
    )
  const launchedHome = () => {
    const record = rig.store.getRecord(SESSION)
    return record ? acquiredAgentSessionAccount(record)?.recipe.home : undefined
  }
  const setupFailed = { rejection: expect.objectContaining({ kind: 'claudeAccountSetupFailed' }) }

  it('stops the live agent for an account being set up, fails each input once if setup fails, and starts the next send on it once ready', async () => {
    await send('on a')
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(1))
    expect(launchedHome()).toBe(home('a'))

    settings.activeClaudeManagedAccountId = 'b'
    const first = await send('to b')
    await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledTimes(2))
    expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION, undefined)
    expect(rig.adapter.dispatch).toHaveBeenCalledTimes(1)
    const second = await send('also to b')

    setup.reject(new Error('setup refused'))
    await vi.waitFor(async () =>
      expect(await submission(first)).toMatchObject({ dispatchState: 'rejected', ...setupFailed })
    )
    await vi.waitFor(async () =>
      expect(await submission(second)).toMatchObject({ dispatchState: 'rejected', ...setupFailed })
    )
    expect(launchedHome()).not.toBe(home('b'))
    const attempts = rig.adapter.acquire.mock.calls.length
    await sweepTicks()
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(attempts)
    expect(rig.adapter.dispatch).toHaveBeenCalledTimes(1)

    ready('b')
    await send('b is ready')
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    expect(launchedHome()).toBe(home('b'))
    const settled = rig.adapter.acquire.mock.calls.length
    await send('still b')
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(3))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(settled)
  })

  it('keeps the live agent when its own selected folder disappears', async () => {
    await send('on a')
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(1))
    rmSync(home('a'), { recursive: true, force: true })
    await send('still on a')
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
  })

  it('starts a resting chat through account preparation instead of refusing the read', async () => {
    // Attach started the child on a; idle release puts the chat at rest before the switch.
    rig.clock.now += IDLE_MS + 1
    await sweepOnce(rig.host)
    await vi.waitFor(() =>
      expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION, undefined)
    )
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
    settings.activeClaudeManagedAccountId = 'b'
    setup.reject(new Error('setup refused'))
    const id = await send('from rest')
    await vi.waitFor(async () =>
      expect(await submission(id)).toMatchObject({ dispatchState: 'rejected', ...setupFailed })
    )
    // The start reached acquisition (which prepares and fails typed) instead of a read refusal.
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
    // Reads that describe the chat still report the missing folder; only dispatch identity ignores it.
    await expect(rig.host.prospectiveAccountHome(SESSION)).rejects.toMatchObject({
      reason: 'claudeAccountFolderMissing'
    })
  })
})

describe('a send after the agent said it is not signed in', () => {
  let rig: RestTestRig

  beforeEach(async () => {
    rig = await createRestTestRig()
  })

  afterEach(async () => {
    await rig.dispose()
  })

  const fence = () => rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1

  it('goes to a new agent, and the new agent is kept for the sends after it', async () => {
    await foundRestTestChat(rig)
    rig.adapter.dispatch.mockImplementationOnce(async () => ({
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), {
        surface: 'rejection'
      })
    }))
    expect((await rig.host.send(CALLER, restTestSend('signed out', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
    rig.adapter.closeSession.mockClear()

    expect((await rig.host.send(CALLER, restTestSend('signed in now', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(3))
    expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION, undefined)
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)

    expect((await rig.host.send(CALLER, restTestSend('and again', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(4))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
  })

  it('keeps the agent after any other rejection', async () => {
    await foundRestTestChat(rig)
    rig.adapter.dispatch.mockImplementationOnce(async () => ({
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('providerRejected'), {
        surface: 'rejection'
      })
    }))
    expect((await rig.host.send(CALLER, restTestSend('refused', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    rig.adapter.dispatch.mockImplementation(async () => acceptedDispatch())

    expect((await rig.host.send(CALLER, restTestSend('next', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(3))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
  })
})

type Row = { itemId: string; fence: number; agentId?: string; body: AgentJournalItemBody }

const statusRow = (
  fence: number,
  kind: 'notSignedIn' | 'providerExited',
  agentId?: string
): Row => ({
  itemId: `status-${fence}-${kind}-${agentId ?? 'root'}`,
  fence,
  ...(agentId ? { agentId } : {}),
  body: {
    kind: 'status',
    ...agentSessionFailureWords(agentSessionFailureFact(kind), { surface: 'row' })
  }
})
const rejected = (fence: number) => ({
  fence,
  dispatchState: 'rejected' as const,
  rejection: agentSessionFailureFact('notSignedIn')
})
const childAt = (
  overrides: Partial<StructuredAgentSessionProviderChild> = {}
): StructuredAgentSessionProviderChild => ({
  generation: 'generation-2',
  fence: 2,
  phase: 'ready',
  ...overrides
})
const conversation = (
  input: {
    child?: StructuredAgentSessionProviderChild | null
    items?: Row[]
    submissions?: ReturnType<typeof rejected>[]
    newestTurnEndedAt?: number
  } = {}
) => {
  const items = input.items ?? []
  return {
    child: input.child === undefined ? childAt() : input.child,
    journal: {
      submissions: () => input.submissions ?? [],
      visitItems: (visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void) =>
        items.forEach((item, index) => visit(item.itemId, index, item.body)),
      visitItemsWithLinkage: (visit: JournalItemLinkageVisitor) =>
        items.forEach((item, index) =>
          visit(item.itemId, index, item.body, item.agentId ? { agentId: item.agentId } : {})
        ),
      itemFence: (itemId: string) => items.find((item) => item.itemId === itemId)?.fence,
      itemBody: (itemId: string) => items.find((item) => item.itemId === itemId)?.body ?? null,
      newestTurn: (): AgentJournalTurnLifecycle | null =>
        input.newestTurnEndedAt === undefined
          ? null
          : { turnId: 'turn-0', state: 'completed', completedAt: input.newestTurnEndedAt }
    }
  }
}

describe('structuredAgentSessionChildReportedSignedOut', () => {
  const reported = (input: Parameters<typeof conversation>[0]) =>
    structuredAgentSessionChildReportedSignedOut(conversation(input))

  it('reads a not-signed-in row the running child wrote', () => {
    expect(reported({ items: [statusRow(2, 'notSignedIn')] })).toBe(true)
  })

  it('ignores one an earlier child or a subagent wrote, and any other failure', () => {
    expect(reported({ items: [statusRow(1, 'notSignedIn')] })).toBe(false)
    expect(reported({ items: [statusRow(2, 'notSignedIn', 'subagent-1')] })).toBe(false)
    expect(reported({ items: [statusRow(2, 'providerExited')] })).toBe(false)
  })

  it('reads a send rejected as not signed in at this child, not at an earlier one', () => {
    expect(reported({ submissions: [rejected(2)] })).toBe(true)
    expect(reported({ submissions: [rejected(1)] })).toBe(false)
  })

  it('leaves a child that is starting, closing, or absent', () => {
    const items = [statusRow(2, 'notSignedIn')]
    expect(reported({ items, child: childAt({ phase: 'starting' }) })).toBe(false)
    expect(reported({ items, child: null })).toBe(false)
  })
})

describe('retireOutgrownStructuredAgentSessionChild', () => {
  const liveChildWork: AgentChildWorkView = {
    id: 'subagent-1',
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: 0,
    observedAt: 0,
    stoppable: false,
    invocation: { invocationId: 'spawn-subagent-1', generation: 1 }
  }
  const idle: Parameters<typeof retireOutgrownStructuredAgentSessionChild>[2]['work'] = {
    currentWork: () => ({ activeTurnId: () => null, hasActionablePrompt: () => false }),
    childWork: () => [],
    childWorkOpen: () => false,
    hasOpenDispatch: () => false,
    providerHoldsDispatch: () => false
  }
  const owing = (turnId: string | null, prompt: boolean): Partial<typeof idle> => ({
    currentWork: () => ({ activeTurnId: () => turnId, hasActionablePrompt: () => prompt })
  })
  const signedOut = { submissions: [rejected(2)] }
  const retire = async (
    input: Parameters<typeof conversation>[0],
    work: Partial<typeof idle> = {},
    stopAgent = vi.fn(async () => undefined),
    launchPermission?: () => Promise<AgentChatPermissionChoice | null>,
    permissionRequiresAcquisition?: (mode: AgentChatPermissionChoice) => boolean
  ) => {
    const warn = vi.fn()
    await retireOutgrownStructuredAgentSessionChild('session', conversation(input), {
      work: { ...idle, ...work },
      ...(launchPermission ? { launchPermission } : {}),
      ...(permissionRequiresAcquisition ? { permissionRequiresAcquisition } : {}),
      stopAgent,
      logger: { warn, error: vi.fn() }
    })
    return { stopAgent, warn }
  }

  it('stops a signed-out child that owes nothing', async () => {
    expect((await retire(signedOut)).stopAgent).toHaveBeenCalledWith('session')
  })

  it('keeps it while it owes work the idle sweep also protects', async () => {
    for (const kept of [
      await retire(signedOut, owing('turn-1', false)),
      await retire(signedOut, { childWorkOpen: () => true }),
      await retire(signedOut, { hasOpenDispatch: () => true }),
      await retire(signedOut, { providerHoldsDispatch: () => true })
    ]) {
      expect(kept.stopAgent).not.toHaveBeenCalled()
    }
  })

  it('keeps it while a result that settled after the last turn may still wake it', async () => {
    const settled: AgentChildWorkView = {
      ...liveChildWork,
      state: 'done',
      membership: 'settled',
      outcome: 'succeeded',
      settledAt: 200
    }
    const after = await retire(
      { ...signedOut, newestTurnEndedAt: 100 },
      { childWork: () => [settled] }
    )
    expect(after.stopAgent).not.toHaveBeenCalled()
    const before = await retire(
      { ...signedOut, newestTurnEndedAt: 300 },
      { childWork: () => [settled] }
    )
    expect(before.stopAgent).toHaveBeenCalledWith('session')
  })

  it('logs a stop that fails and lets the send go on', async () => {
    const { warn } = await retire(
      signedOut,
      {},
      vi.fn(async () => {
        throw new Error('exit not proven')
      })
    )
    expect(warn).toHaveBeenCalledWith(
      'replacing an outgrown agent failed',
      expect.objectContaining({ sessionId: 'session' })
    )
  })

  describe('a child launched under another account', () => {
    const onA = { child: childAt({ accountHome: accountHome('/accounts/a') }) }
    const stops = async (
      input: Parameters<typeof conversation>[0],
      now: () => Promise<LegacyAgentSessionAccountHome | null>,
      work: Partial<typeof idle> = {}
    ) => {
      const stopAgent = vi.fn(async () => undefined)
      await retireOutgrownStructuredAgentSessionChild('session', conversation(input), {
        work: { ...idle, ...work },
        launchAccountHome: now,
        stopAgent,
        logger: { warn: vi.fn(), error: vi.fn() }
      })
      return stopAgent.mock.calls.length > 0
    }

    it('is stopped when a start would launch under another account, and kept under the same one', async () => {
      expect(await stops(onA, async () => accountHome('/accounts/b'))).toBe(true)
      expect(await stops(onA, async () => accountHome('/accounts/a'))).toBe(false)
    })

    it('is kept mid-reply, with work open, or while starting', async () => {
      const onB = async () => accountHome('/accounts/b')
      expect(await stops(onA, onB, owing('turn-1', false))).toBe(false)
      expect(await stops(onA, onB, { childWorkOpen: () => true })).toBe(false)
      const starting = {
        child: childAt({ accountHome: accountHome('/accounts/a'), phase: 'starting' })
      }
      expect(await stops(starting, onB)).toBe(false)
    })

    it('keeps account custody with an open Dispatch even when the model also needs a restart', async () => {
      for (const modelTransition of [false, true]) {
        let open = true
        const stopAgent = vi.fn(async () => undefined)
        const deps = {
          work: { ...idle, hasOpenDispatch: () => open },
          launchAccountHome: async () => accountHome('/accounts/b'),
          requiresModelTransitionRestart: () => modelTransition,
          next: {
            clientMessageId: 'next',
            fence: 2,
            payloadFingerprint: 'next',
            dispatchState: 'pending' as const,
            providerItemId: null,
            reason: null,
            submittedAt: 0,
            resolvedAt: null
          },
          stopAgent,
          logger: { warn: vi.fn(), error: vi.fn() }
        }
        const session = conversation(onA)
        await retireOutgrownStructuredAgentSessionChild('session', session, deps)
        expect(stopAgent).not.toHaveBeenCalled()
        open = false
        await retireOutgrownStructuredAgentSessionChild('session', session, deps)
        expect(stopAgent).toHaveBeenCalledExactlyOnceWith('session')
      }
    })

    it('is kept when the account cannot be read, or the agent keeps its own', async () => {
      expect(
        await stops(onA, async () => {
          throw new Error('native evidence is unreadable')
        })
      ).toBe(false)
      expect(await stops(onA, async () => null)).toBe(false)
      expect(await stops({ child: childAt() }, async () => accountHome('/accounts/b'))).toBe(false)
    })
  })

  describe('a child launched with another permission mode', () => {
    const now = (mode: AgentChatPermissionChoice) => vi.fn(async () => mode)
    const askChild = { child: childAt({ permissionMode: 'ask' }) }

    it('is stopped once, and one launched with the current mode is kept', async () => {
      expect(
        (await retire(askChild, {}, undefined, now('full-access'))).stopAgent
      ).toHaveBeenCalledWith('session')
      expect((await retire(askChild, {}, undefined, now('ask'))).stopAgent).not.toHaveBeenCalled()
    })

    it('keeps a child that can apply policy per turn, and acquires unknown Auto only when idle', async () => {
      expect(
        (await retire(askChild, {}, undefined, now('full-access'), () => false)).stopAgent
      ).not.toHaveBeenCalled()
      expect(
        (await retire(askChild, { childWorkOpen: () => true }, undefined, now('auto'), () => true))
          .stopAgent
      ).not.toHaveBeenCalled()
      expect(
        (await retire(askChild, {}, undefined, now('auto'), () => true)).stopAgent
      ).toHaveBeenCalledWith('session')
    })

    it('is kept while it owes work, as a signed-out one is', async () => {
      for (const kept of [
        await retire(askChild, owing('turn-1', false), undefined, now('auto')),
        await retire(askChild, { childWorkOpen: () => true }, undefined, now('auto')),
        await retire(askChild, owing(null, true), undefined, now('auto'))
      ]) {
        expect(kept.stopAgent).not.toHaveBeenCalled()
      }
    })

    it('is kept while starting, or for an agent with no modes', async () => {
      const starting = { child: childAt({ permissionMode: 'ask', phase: 'starting' }) }
      expect((await retire(starting, {}, undefined, now('auto'))).stopAgent).not.toHaveBeenCalled()
      expect(
        (await retire(askChild, {}, undefined, async () => null)).stopAgent
      ).not.toHaveBeenCalled()
    })

    it('never reads the mode for a child launched with none', async () => {
      const current = now('full-access')
      expect((await retire({}, {}, undefined, current)).stopAgent).not.toHaveBeenCalled()
      expect(current).not.toHaveBeenCalled()
    })
  })

  it('keeps healthy acquired Claude A for canonical native result mail without provider children', async () => {
    const fixture = await createReceivingAccountFixture()
    try {
      await fixture.turn('completed-lead', 'completed')
      const next = await fixture.submit({
        kind: 'message',
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: 'You have 1 orchestration message. Run `orca-dev orchestration check --run run_01227aad9fcf`.'
          }
        ],
        from: {
          kind: 'agent',
          senders: [
            {
              party: {
                address: 'structworker_e7f53907-0cde-40b9-81c5-d18eb66c07a4',
                terminalHandle: 'structworker_e7f53907-0cde-40b9-81c5-d18eb66c07a4',
                orcaSessionId: testOrcaSessionId('d93bb955-2f5f-4206-93e9-cbbc9460d7e3')
              },
              name: 'QA30955 wake-home child'
            }
          ],
          orchestration: {
            message: 'mail-notice',
            mailbox: 'run:run_01227aad9fcf',
            dispatchId: null,
            messages: [
              {
                messageId: 'msg_1df05968e9bb',
                runId: 'run_01227aad9fcf',
                from: 'structworker_e7f53907-0cde-40b9-81c5-d18eb66c07a4'
              }
            ]
          }
        }
      })
      const child = fixture.session.child
      const stopAgent = vi.fn(async () => undefined)
      await retireOutgrownStructuredAgentSessionChild(fixture.root, fixture.session, {
        next,
        work: idle,
        launchAccountHome: async () =>
          (
            await structuredAgentSessionReceivingAccount(
              fixture.deps,
              fixture.record,
              fixture.session,
              next
            )
          ).home,
        stopAgent,
        logger: { warn: vi.fn(), error: vi.fn() }
      })
      expect(stopAgent).not.toHaveBeenCalled()
      expect(fixture.session.child).toBe(child)
    } finally {
      await fixture.dispose()
    }
  })
})
