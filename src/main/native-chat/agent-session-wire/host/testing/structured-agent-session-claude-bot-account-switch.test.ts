import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionAccountHomePath } from '../../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { claudeProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store'
import {
  openTestAgentSessionDatabase,
  openTestAgentSessionRecordStore
} from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import { claudeAndCodexDeclared } from '../../providers/testing/structured-agent-session-adapter-router.test-fixture'
import { admitStructuredAgentSessionInput } from '../../delivery/structured-agent-session-input-admission'
import { StructuredAgentSessionHost } from '../structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../structured-agent-session-registry'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data.test-fixture'
import { createStructuredAgentSessionLogger } from '../structured-agent-session-logger'
import { createClaudeAccountRouting } from './structured-agent-session-claude-account-routing.test-fixture'
import {
  installClaudeBotAccountFollow,
  settledClaudeBotAccountFollow,
  type ClaudeBotAccountFollowStore
} from '../../termination/claude-bot-account-follow'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let accounts: ReturnType<ReturnType<typeof createClaudeAccountRouting>['install']>
let botHome: boolean
let workOwed: boolean
const launches: string[] = []
const CALLER = { callerKey: 'client-1' }
const dispatched: { clientMessageId: string; fence: number }[] = []
const listeners: Parameters<ClaudeBotAccountFollowStore['onSettingsChanged']>[0][] = []
let selectedAccount: 'a' | 'b' | null = 'a'

const acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>(async ({ fence, spawnToken }) => {
  const record = store.getRecord(SESSION)
  if (!record) {
    throw new Error('missing session')
  }
  const accountHome = await host.deps.launchAccountHome?.(record, 'identity')
  if (!accountHome || !('path' in accountHome)) {
    throw new Error('claude launch has no account home')
  }
  launches.push(accountHome.path)
  return {
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    acquisitionGeneration: `generation-${fence}`,
    accountHome,
    link: {
      linkId: `link-${fence}`,
      handle: claudeProviderHandle(THREAD, null),
      origin: fence === 1 ? ('created' as const) : ('resumed' as const),
      mintedAtFence: fence,
      observedAt: NOW
    }
  }
})
const closeSession = vi.fn(async () => true)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-bot-account-'))
  resetHostTestOperationIds()
  botHome = true
  workOwed = false
  launches.length = 0
  listeners.length = 0
  selectedAccount = 'a'
  dispatched.length = 0
  acquire.mockClear()
  closeSession.mockClear()
  store = await openTestAgentSessionRecordStore(root)
  const routing = createClaudeAccountRouting()
  accounts = routing.install(root, () => store)
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire,
      dispatch: vi.fn(async (input) => {
        await admitStructuredAgentSessionInput(input.admitFreshInput, () => {
          dispatched.push({ clientMessageId: input.clientMessageId, fence: input.fence })
        })
        return {
          state: 'accepted' as const,
          providerIdentity: {
            provider: 'claude' as const,
            sessionId: THREAD,
            uuid: 'message-1'
          }
        }
      }),
      closeSession,
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined),
      open: async () => ({ reportedOptions: { model: '' } })
    },
    journalDatabase: await openTestAgentSessionDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    hasOpenDispatch: () => workOwed,
    isBotHome: () => botHome,
    launchAccountHome: routing.launchAccountHome,
    now: () => NOW
  })
  setStructuredAgentSessionHost(host)
  installClaudeBotAccountFollow({
    getSettings: () => ({
      activeClaudeManagedAccountId: selectedAccount,
      activeClaudeManagedAccountIdsByRuntime: { host: selectedAccount, wsl: {} }
    }),
    onSettingsChanged: (listener) => {
      listeners.push(listener)
      return () => {}
    }
  })
  expect(
    await host.attach(
      CALLER,
      hostTestAttachParams(null, {
        provider: 'claude',
        agent: 'claude',
        providerHandle: { kind: 'claude', sessionId: THREAD, leafUuid: null },
        accountHome: accounts.homeA
      })
    )
  ).toMatchObject({ ok: true })
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  accounts.uninstall()
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

async function notify(account: 'a' | 'b' | null): Promise<void> {
  accounts.select(account)
  selectedAccount = account
  const settings = {
    activeClaudeManagedAccountId: account,
    activeClaudeManagedAccountIdsByRuntime: { host: account, wsl: {} }
  }
  for (const listener of listeners) {
    listener(settings, settings)
  }
  await settledClaudeBotAccountFollow()
}

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const envelope = {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: SESSION,
      fields: { body }
    })
  }
  expect(await host.send(CALLER, { envelope, body })).toMatchObject({ ok: true })
  return envelope.clientOperationId
}

async function delivered(id: string): Promise<{ clientMessageId: string; fence: number }> {
  await vi.waitFor(() => expect(dispatched.some((row) => row.clientMessageId === id)).toBe(true), {
    timeout: 10_000
  })
  return dispatched.find((row) => row.clientMessageId === id)!
}

async function started(): Promise<number> {
  const id = await send('first')
  return (await delivered(id)).fence
}

it('stops an idle bot when the host Claude account changes and resumes it on the new account', async () => {
  const first = await started()
  expect(launches).toEqual([accounts.homeA.path])
  expect(agentSessionAccountHomePath(host.childAccountHome(SESSION) ?? null)).toBe(
    accounts.homeA.path
  )
  // A bot's chat stays open. `anyway` is what still stops it.
  await host.subscribe({ id: 'pane', sessionId: SESSION, emit: () => {} })

  await notify('b')

  expect(host.childAccountHome(SESSION)).toBeUndefined()
  const next = await delivered(await send('continue'))

  expect(launches).toEqual([accounts.homeA.path, accounts.homeB.path])
  expect(next.fence).toBeGreaterThan(first)
  expect(store.getRecord(SESSION)!.providerHandleChain.map((link) => link.handle)).toEqual([
    claudeProviderHandle(THREAD, null),
    claudeProviderHandle(THREAD, null)
  ])
})

it('keeps a bot that still owes a turn, then launches the next one on the new account', async () => {
  const first = await started()
  workOwed = true

  await notify('b')

  expect(agentSessionAccountHomePath(host.childAccountHome(SESSION) ?? null)).toBe(
    accounts.homeA.path
  )
  expect(launches).toEqual([accounts.homeA.path])

  workOwed = false
  const next = await delivered(await send('after the turn'))

  expect(launches).toEqual([accounts.homeA.path, accounts.homeB.path])
  expect(next.fence).toBeGreaterThan(first)
})

it('leaves a non-bot Claude chat on its process until the next message', async () => {
  botHome = false
  await started()

  await notify('b')

  expect(agentSessionAccountHomePath(host.childAccountHome(SESSION) ?? null)).toBe(
    accounts.homeA.path
  )
  await delivered(await send('continue'))
  expect(launches).toEqual([accounts.homeA.path, accounts.homeB.path])
})

it('stops an idle bot when the host selection becomes System default', async () => {
  await started()

  await notify(null)

  expect(host.childAccountHome(SESSION)).toBeUndefined()
  await delivered(await send('continue'))
  expect(launches).toEqual([accounts.homeA.path, accounts.systemHome.path])
})

it('does not stop a bot when the selected host account is unchanged', async () => {
  await started()

  await notify('a')

  expect(agentSessionAccountHomePath(host.childAccountHome(SESSION) ?? null)).toBe(
    accounts.homeA.path
  )
  expect(launches).toEqual([accounts.homeA.path])
})

it('does not stop a bot when only a WSL Claude account changes', async () => {
  await started()
  const settings = {
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: { host: 'a', wsl: { Ubuntu: 'b' } }
  }
  for (const listener of listeners) {
    listener(settings, settings)
  }
  await settledClaudeBotAccountFollow()

  expect(agentSessionAccountHomePath(host.childAccountHome(SESSION) ?? null)).toBe(
    accounts.homeA.path
  )
  expect(launches).toEqual([accounts.homeA.path])
})
