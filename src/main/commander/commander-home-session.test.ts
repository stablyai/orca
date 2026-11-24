import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as Lineage from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { makeTestBot } from '../bots/bot.test-fixture'
import { BotLaunchTools } from '../bots/bot-launch-tools'
import { agentSessionRecordFixture } from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { COMMANDER_HOME_CAPABILITY_ENV } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { readAgentSessionRecordStore } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { principal, epoch } from './commander-recovery-account'
import { askHomeMemoryPreference } from './commander-memory-service'
import {
  askFromCommanderHome,
  commanderHomeLaunchCapability,
  installCommanderHomePreferences
} from './commander-home-session'
import { COMMANDER_CHAT_ASK_PREFERENCE } from '../runtime/rpc/methods/commander-chat-preference'
import type { RpcContext } from '../runtime/rpc/core'

vi.mock(
  '../runtime/orchestration/addressing/session-lineage/structured-session-lineage',
  async (original) => ({
    ...(await original<typeof Lineage>()),
    readAgentSessionRecordStore: vi.fn()
  })
)
vi.mock('./commander-recovery-account', () => ({ principal: vi.fn(), epoch: vi.fn() }))
vi.mock('./commander-memory-service', () => ({ askHomeMemoryPreference: vi.fn() }))

const owner = {
  account: { profileId: 'profile', userId: 'owner', activeOrgId: 'org' },
  directory: '',
  ticket: 'epoch1'
}
const project = 'github:acme/app'
const record = agentSessionRecordFixture()
const bot = makeTestBot({
  systemRole: 'commander',
  agent: 'claude',
  chatSessionId: record.sessionId
})
const ask = { projectId: project, question: 'Test suite?', requestId: 'worker1-q1' }
let projects = [project]
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The proof reads the system bot, current lease, and visible project set only.
const runtime = {
  bots: { enabled: () => true, list: () => [bot] },
  listVisibleProjectHostSetups: () => projects.map((projectId) => ({ projectId }))
} as unknown as OrcaRuntimeService
let uninstall: () => void

beforeEach(() => {
  vi.resetAllMocks()
  bot.chatSessionId = record.sessionId
  bot.systemRole = 'commander'
  Object.assign(record.location, {
    workspaceKind: 'folder',
    workspaceId: 'folder:w1',
    executionHostId: 'local',
    wslDistro: null
  })
  record.lease.claimStatus = 'reserved'
  record.lease.runtimeFence = 7
  projects = [project]
  vi.mocked(principal).mockResolvedValue(owner)
  vi.mocked(epoch).mockReturnValue(owner.ticket)
  vi.mocked(readAgentSessionRecordStore).mockReturnValue({
    getRecord: (id) => (id === record.sessionId ? agentSessionConversationView(record) : null),
    listRecords: () => []
  })
  vi.mocked(askHomeMemoryPreference).mockResolvedValue({ matched: false, reason: 'missing' })
  uninstall = installCommanderHomePreferences(runtime)
})
afterEach(() => {
  uninstall()
  vi.useRealTimers()
})

async function start() {
  const capability = await commanderHomeLaunchCapability(record)
  expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/)
  record.lease.claimStatus = 'live'
  return { ...ask, capability: capability! }
}

it('authorizes only the registered Home launch on its desktop, with its account, known project and current live fence', async () => {
  const request = await start()
  await expect(
    COMMANDER_CHAT_ASK_PREFERENCE.handler(request, { runtime, caller: { kind: 'local-cli' } })
  ).resolves.toEqual({ matched: false, reason: 'missing' })
  expect(askHomeMemoryPreference).toHaveBeenCalledWith(
    owner.account,
    bot.id,
    project,
    ask.question,
    ask.requestId,
    expect.any(Function)
  )
  for (const transport of [
    {},
    { caller: { kind: 'desktop' } },
    { caller: { kind: 'paired-device', deviceId: 'phone' } },
    { caller: { kind: 'local-cli' }, pairedDeviceId: 'paired' },
    { caller: { kind: 'local-cli' }, clientKind: 'runtime' }
  ] as const satisfies readonly Partial<RpcContext>[]) {
    expect(() => COMMANDER_CHAT_ASK_PREFERENCE.handler(request, { runtime, ...transport })).toThrow(
      'local Commander'
    )
  }
  await expect(
    askFromCommanderHome(runtime, { ...request, capability: 'x'.repeat(43) })
  ).rejects.toThrow()
  projects = []
  await expect(askFromCommanderHome(runtime, request)).rejects.toThrow()
  projects = [project]
  record.lease.runtimeFence++
  await expect(askFromCommanderHome(runtime, request)).rejects.toThrow()
  expect(askHomeMemoryPreference).toHaveBeenCalledTimes(1)
})

it('fences switched accounts even after switching back, stopped sessions, old launches and expired capabilities', async () => {
  vi.useFakeTimers()
  const first = await start()
  const current = await start()
  await expect(askFromCommanderHome(runtime, first)).rejects.toThrow()
  vi.mocked(epoch).mockReturnValue('reauthenticated')
  await expect(askFromCommanderHome(runtime, current)).rejects.toThrow()
  vi.mocked(epoch).mockReturnValue(owner.ticket)
  record.lease.claimStatus = 'released'
  await expect(askFromCommanderHome(runtime, current)).rejects.toThrow()
  record.lease.claimStatus = 'live'
  bot.chatSessionId = 'replacement'
  await expect(askFromCommanderHome(runtime, current)).rejects.toThrow()
  bot.chatSessionId = record.sessionId
  vi.advanceTimersByTime(8 * 60 * 60 * 1000)
  await expect(askFromCommanderHome(runtime, current)).rejects.toThrow()
  expect(askHomeMemoryPreference).not.toHaveBeenCalled()
})

it('never provisions cloud authority for unsigned, non-Home, WSL, sibling or headless launches', async () => {
  await expect(
    commanderHomeLaunchCapability({ ...record, sessionId: 'sibling' })
  ).resolves.toBeNull()
  record.location.wslDistro = 'Ubuntu'
  await expect(commanderHomeLaunchCapability(record)).resolves.toBeNull()
  record.location.wslDistro = null
  bot.systemRole = undefined
  await expect(commanderHomeLaunchCapability(record)).resolves.toBeNull()
  expect(principal).not.toHaveBeenCalled()
  bot.systemRole = 'commander'
  vi.mocked(principal).mockResolvedValue(null)
  await expect(commanderHomeLaunchCapability(record)).resolves.toBeNull()
  uninstall()
  vi.mocked(principal).mockResolvedValue(owner)
  await expect(commanderHomeLaunchCapability(record)).resolves.toBeNull()
})

it('withholds an in-flight reply after its chat was replaced', async () => {
  const request = await start()
  vi.mocked(askHomeMemoryPreference).mockImplementation(async (...args) => {
    args[5]()
    bot.chatSessionId = 'replacement'
    return { matched: false, reason: 'missing' }
  })
  await expect(askFromCommanderHome(runtime, request)).rejects.toThrow()
})

it('keeps the Codex token off its snapshot environment, while Claude receives it only for this launch', () => {
  const codex = BotLaunchTools.none.withCommanderCapability('codex', 'cap')
  const claude = BotLaunchTools.none.withCommanderCapability('claude', 'cap')
  expect(codex.env).not.toHaveProperty(COMMANDER_HOME_CAPABILITY_ENV)
  expect(codex.commandEnv).toHaveProperty(COMMANDER_HOME_CAPABILITY_ENV, 'cap')
  expect(claude.env).toHaveProperty(COMMANDER_HOME_CAPABILITY_ENV, 'cap')
  expect(BotLaunchTools.none.env).not.toHaveProperty(COMMANDER_HOME_CAPABILITY_ENV)
})
