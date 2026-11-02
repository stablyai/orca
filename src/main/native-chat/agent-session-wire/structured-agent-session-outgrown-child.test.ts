import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { acquiredAgentSessionAccount } from '../../../shared/agent-session-acquired-account'
import {
  agentSessionAccountHome,
  type LegacyAgentSessionAccountHome
} from '../../../shared/agent-session/lifecycle/agent-session-account-home'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { installClaudeProfileRouter } from '../../claude-accounts/claude-profile-installed-router'
import {
  ClaudeProfileRouter,
  type ClaudeProfileRouterSettings
} from '../../claude-accounts/claude-profile-router'
import type { ClaudeProfileSetupReport } from '../../claude-accounts/claude-profile-setup'
import { prepareClaudeLaunchAccount } from '../../claude/claude-launch-account'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/structured/claude-structured-agent-definition'
import { resolveStructuredClaudeAccountHomePath } from '../../runtime/structured-agent-account-home'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import {
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
          await resolveStructuredClaudeAccountHomePath({
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
      const recipe = await prepareClaudeLaunchAccount(router, {}, home('a'))
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
})
