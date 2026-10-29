import { cancelLocalGeneration } from '../text-generation/source-control-generation-lanes'
import { AgentSessionJournal } from './agent-session-journal/journal-store'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { structuredChatNamingDeps } from '../runtime/structured-chat-naming-runtime'
import { getDefaultSettings } from '../../shared/constants'
import { setStructuredAgentSessionHost } from './agent-session-wire/structured-agent-session-registry'
import * as agentLaunch from '../text-generation/source-control-agent-launch'
import * as homeLock from '../codex-cli/codex-home-process-lock'
import { createMockDiscoveryChild } from '../text-generation/commit-message-text-generation-test-harness'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createStructuredChatNamingHandler } from './structured-chat-naming'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './agent-session-wire/structured-agent-session-host-test-harness'
import {
  hostTestAttachParams,
  HOST_TEST_SESSION,
  hostTestMessage
} from './agent-session-wire/structured-agent-session-host-test-data'

async function send(text: string, sessionId = HOST_TEST_SESSION) {
  const body = hostTestMessage(text)
  const mutation = { method: 'agentSession.send', sessionId, fields: { body } }
  expect(
    await hostTestState().host.send(CALLER, {
      body,
      envelope: envelope(mutation.method, mutation.fields, {
        sessionId,
        payloadFingerprint: computeAgentSessionPayloadFingerprint(mutation)
      })
    })
  ).toMatchObject({ ok: true })
}
async function clearContext() {
  expect(
    await hostTestState().host.conversationCommand(CALLER, {
      envelope: envelope('agentSession.conversationCommand', { command: 'clear' }),
      command: 'clear'
    })
  ).toMatchObject({ ok: true })
}

function titleChild(title: string) {
  const child = createMockDiscoveryChild()
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(title))
    child.emit('close', 0)
  })
  return child
}

function productionNaming(home: string) {
  const { host, store, log } = hostTestState()
  setStructuredAgentSessionHost(host)
  onTestFinished(() => {
    setStructuredAgentSessionHost(null)
    vi.restoreAllMocks()
  })
  const settings = getDefaultSettings('/isolated')
  settings.defaultTuiAgent = 'codex'
  const deps = structuredChatNamingDeps(
    () => ({ getSettings: () => settings }),
    {
      resolveWorkspace: async () => ({ path: '/same-folder', executionHostId: 'local' }),
      getAgentEnvResolvers: () => ({
        resolveBaseEnvironment: async () => ({ CODEX_HOME: home })
      }),
      workerTaskTitle: () => null,
      retitleOpenTab: () => {}
    },
    log.logger
  )
  const naming = createStructuredChatNamingHandler({ ...deps, now: () => 0 })
  host.deps.onSessionStatusChanged = naming
  host.deps.conversationNaming = naming
  return { host, store, naming, settings }
}

it.each([
  [10, 'latest'],
  [100, 'latest'],
  [10, 'manual'],
  [10, 'off'],
  [10, 'cancel']
] as const)('bounds actual title admission across %i seeded contexts (%s)', async (count, mode) => {
  const home = `/isolated/naming-${count}`
  const { host, store, naming, settings } = productionNaming(home)
  const held = Promise.withResolvers<void>()
  let pending = 0
  const lock = homeLock.withCodexHomeProcessLock
  const admissions = vi
    .spyOn(homeLock, 'withCodexHomeProcessLock')
    .mockImplementation(<T>(key: string, callback: () => Promise<T>) => {
      pending++
      return lock(key, callback).finally(() => {
        pending--
      })
    })
  const predecessor = homeLock.withCodexHomeProcessLock(home, () => held.promise)
  const order: string[] = []
  const spawn = vi.spyOn(agentLaunch, 'spawnSourceControlAgent').mockImplementation(() => {
    order.push(spawn.mock.calls.length === 1 ? 'B' : 'A')
    return titleChild('Latest title')
  })
  await attach()
  for (let index = 0; index < count; index++) {
    if (index) {
      await clearContext()
    }
    await send(`Context ${index}`)
    await vi.waitFor(() =>
      expect(store.getRecord(HOST_TEST_SESSION)?.conversationName).toBe(`Context ${index}`)
    )
    await host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', { turnId: 'turn-1' }),
      turnId: 'turn-1'
    })
  }
  await vi.waitFor(() => expect(admissions).toHaveBeenCalledTimes(2))
  expect(spawn).not.toHaveBeenCalled()
  if (mode === 'cancel') {
    cancelLocalGeneration('conversation-name', '/same-folder')
    await new Promise<void>((done) => setImmediate(done))
    expect(pending).toBe(2)
    expect(admissions).toHaveBeenCalledTimes(2)
  }
  const unrelated = homeLock.withCodexHomeProcessLock(home, async () => {
    order.push('U')
  })
  const other = hostTestAttachParams(null)
  other.envelope.sessionId = 'session-beta'
  expect(
    await host.attach(CALLER, hostTestAttachParams(null, { envelope: other.envelope }))
  ).toMatchObject({ ok: true })
  await send('Same folder, other chat', 'session-beta')
  await vi.waitFor(() => expect(admissions).toHaveBeenCalledTimes(4))
  expect(pending).toBe(4)
  if (mode === 'manual') {
    await naming.setUserName(HOST_TEST_SESSION, 'Manual', 'rename')
  }
  if (mode === 'off') {
    settings.nativeChatAutoName = false
  }
  held.resolve()
  await Promise.all([predecessor, unrelated])
  await vi.waitFor(() =>
    expect(store.getRecord(HOST_TEST_SESSION)?.conversationName).toBe(
      mode === 'manual' ? 'Manual' : mode === 'off' ? `Context ${count - 1}` : 'Latest title'
    )
  )
  await vi.waitFor(() => expect(pending).toBe(0))
  expect(order).toEqual(mode === 'off' ? ['U'] : mode === 'manual' ? ['U', 'B'] : ['U', 'B', 'A'])
  expect(admissions).toHaveBeenCalledTimes(mode === 'manual' || mode === 'off' ? 4 : 5)
  expect(spawn).toHaveBeenCalledTimes(mode === 'off' ? 0 : mode === 'manual' ? 1 : 2)
  expect(naming.activeSessionIds()).toEqual([])
})

it.each([10, 100])(
  'bounds reopened source and seed supersession across %i contexts',
  async (count) => {
    const { host, store } = hostTestState()
    await attach()
    const sendAndWait = async (text: string) => {
      await send(text)
      await vi.waitFor(() =>
        expect(host.readStatusSummary(HOST_TEST_SESSION)?.status).toBe('working')
      )
    }
    const clear = async () => {
      await host.cancel(CALLER, {
        envelope: envelope('agentSession.cancel', { turnId: 'turn-1' }),
        turnId: 'turn-1'
      })
      await clearContext()
    }
    await sendAndWait('Old journal input')
    await host.close(HOST_TEST_SESSION, 'evict')
    const { naming } = productionNaming('/isolated/source-proof')
    const opening = Promise.withResolvers<void>()
    const open = AgentSessionJournal.prototype.open
    let openOutstanding = 0,
      openPeak = 0
    const opens = vi
      .spyOn(AgentSessionJournal.prototype, 'open')
      .mockImplementation(async function (this: AgentSessionJournal) {
        openPeak = Math.max(openPeak, ++openOutstanding)
        try {
          await opening.promise
          return await open.call(this)
        } finally {
          openOutstanding--
        }
      })
    const reads = vi.spyOn(host, 'journalSnapshot')
    const seed = Promise.withResolvers<void>()
    const generated = Promise.withResolvers<void>()
    const publications = vi.spyOn(host, 'publishConversationName')
    const phases: [string, number][] = []
    const cas = store.compareAndSetConversationName
    vi.spyOn(store, 'compareAndSetConversationName').mockImplementation(async (...args) => {
      const result = await cas(...args)
      phases.push([args[1] === 'Current title' ? 'result' : 'seed', publications.mock.calls.length])
      await (args[1] !== 'Current title' ? seed.promise : generated.promise)
      return result
    })
    const spawn = vi
      .spyOn(agentLaunch, 'spawnSourceControlAgent')
      .mockImplementation(() => titleChild('Current title'))
    onTestFinished(() => {
      opening.resolve()
      seed.resolve()
      generated.resolve()
    })
    naming.regenerate(HOST_TEST_SESSION)
    for (let index = 0; index < count; index++) {
      naming.regenerate(HOST_TEST_SESSION)
    }
    await vi.waitFor(() => expect(opens).toHaveBeenCalledOnce())
    expect(openOutstanding).toBe(1)
    opening.resolve()
    await vi.waitFor(() =>
      expect(store.getRecord(HOST_TEST_SESSION)?.conversationName).toBe('Current title')
    )
    // A new live input seeds independently of the held result, then newer clears supersede it.
    for (let index = 0; index < count; index++) {
      await clear()
      await sendAndWait(`Input ${index}`)
    }
    expect(reads).toHaveBeenCalledTimes(2)
    expect(spawn).toHaveBeenCalledOnce()
    await clear()
    const beforeLatest = publications.mock.calls.length
    await sendAndWait('Final input')
    seed.resolve()
    await vi.waitFor(() =>
      expect(store.getRecord(HOST_TEST_SESSION)?.conversationName).toBe('Final input')
    )
    expect(openPeak).toBe(1)
    expect(openOutstanding).toBe(0)
    expect(reads).toHaveBeenCalledTimes(3)
    expect(phases.at(-1)).toEqual(['seed', beforeLatest + 2])
    const resultPublications = publications.mock.calls.length
    expect(naming.activeSessionIds()).toEqual([HOST_TEST_SESSION])
    generated.resolve()
    await vi.waitFor(() => expect(naming.activeSessionIds()).toEqual([]))
    expect(store.getRecord(HOST_TEST_SESSION)?.conversationName).toBe('Current title')
    expect(phases.at(-1)).toEqual(['result', resultPublications + 2])
    expect(publications).toHaveBeenCalledTimes(resultPublications + 4)
    expect(phases.filter(([phase]) => phase === 'seed')).toHaveLength(2)
    expect(spawn).toHaveBeenCalledTimes(2)
  }
)
