import {
  assertCliConversationWritersExited,
  posixCliWriterShellAlone
} from '../../runtime/structured-agent-cli-writers'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
const physicalSnapshot = vi.hoisted(() => vi.fn())
vi.mock('../../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFreshShellForegroundSnapshot: physicalSnapshot
}))
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  NO_STRUCTURED_AGENTS,
  structuredAgentsDeclaringNothing
} from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { structuredAgentRuntimeRegistration } from '../../runtime/structured-agent-runtime-registrations'
import { attachFingerprintFields } from './structured-agent-session-attach'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let terminalWriting: boolean
const CALLER = { callerKey: 'client-1' }
const acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>(async ({ fence, spawnToken }) => ({
  process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
  acquisitionGeneration: `generation-${fence}`,
  link: {
    linkId: `link-${fence}`,
    handle: codexProviderHandle(THREAD),
    origin: fence === 1 ? ('created' as const) : ('resumed' as const),
    mintedAtFence: fence,
    observedAt: NOW
  }
}))
const assertNoTerminalWriter = vi.fn(async (_record: AgentSessionRecord) => {
  if (terminalWriting) {
    throw agentSessionRefusalError('agent_session_conflict', {
      reason: 'conversationHeldElsewhere'
    })
  }
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-terminal-writer-acquire-'))
  resetHostTestOperationIds()
  terminalWriting = false
  physicalSnapshot.mockReset()
  acquire.mockClear()
  assertNoTerminalWriter.mockReset().mockImplementation(async () => {
    if (terminalWriting) {
      throw agentSessionRefusalError('agent_session_conflict', {
        reason: 'conversationHeldElsewhere'
      })
    }
  })
  const openCode = structuredAgentRuntimeRegistration('opencode')
  if (!openCode) {
    throw new Error('OpenCode is not registered')
  }
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: structuredAgentsDeclaringNothing([
      ...NO_STRUCTURED_AGENTS.definitions(),
      openCode.definition
    ]),
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire,
      dispatch: vi.fn(async () => ({
        state: 'accepted' as const,
        providerIdentity: { provider: 'codex' as const, threadId: THREAD, turnId: 't', ordinal: 1 }
      })),
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined),
      open: async () => ({ reportedOptions: { model: '' } })
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    assertNoTerminalWriter,
    now: () => NOW
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabase(root)
  await rm(root, { recursive: true, force: true })
})

async function send(text: string, sessionId = SESSION): Promise<string> {
  const body = hostTestMessage(text)
  const envelope = {
    sessionId,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId,
      fields: { body }
    })
  }
  expect(await host.send(CALLER, { envelope, body })).toMatchObject({ ok: true })
  return envelope.clientOperationId
}

async function rejection(id: string, sessionId = SESSION) {
  await vi.waitFor(
    async () =>
      expect(
        (await host.journalSnapshot(sessionId)).submissions.find((s) => s.clientMessageId === id)
          ?.dispatchState
      ).toBe('rejected'),
    { timeout: 10_000 }
  )
  return (await host.journalSnapshot(sessionId)).submissions.find((s) => s.clientMessageId === id)
}

// H10: a chat reopened while its conversation runs in a terminal starts no second writer.
it('refuses the chat agent start while a terminal writes its conversation, once per send', async () => {
  await host.close(SESSION, 'evict')
  terminalWriting = true
  await host.revealSession(SESSION)
  const spawnsBefore = acquire.mock.calls.length
  assertNoTerminalWriter.mockClear()

  const first = await rejection(await send('first'))
  expect(first?.rejection).toMatchObject({ kind: 'conversationOpenInTerminal' })
  expect(first?.reason).toBe(
    'Codex is already running this conversation in another terminal. Quit Codex there or close that terminal to continue here.'
  )
  expect(acquire.mock.calls.length).toBe(spawnsBefore)
  expect(store.getRecord(SESSION)?.lease.reservedSpawnToken).toBeNull()

  await rejection(await send('second'))
  expect(assertNoTerminalWriter).toHaveBeenCalledTimes(2)
  expect(acquire.mock.calls.length).toBe(spawnsBefore)

  terminalWriting = false
  await send('after the terminal exits')
  await vi.waitFor(() => expect(acquire.mock.calls.length).toBe(spawnsBefore + 1), {
    timeout: 10_000
  })
})

it('acquires when only a saved Sleep note remains, but refuses an existing unknown terminal', async () => {
  const saved: SleepingAgentSessionRecord = {
    paneKey: 'slept',
    worktreeId: 'workspace-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: THREAD },
    prompt: '',
    state: 'done',
    origin: 'worktree-sleep',
    capturedAt: 1,
    updatedAt: 1
  }
  let terminalExists = true
  assertNoTerminalWriter.mockImplementation((record) =>
    assertCliConversationWritersExited(
      {
        saved: () => [saved],
        rows: () => [],
        links: () => [],
        observation: () => null,
        sleeping: () => true,
        terminal: () => (terminalExists ? { pane: null } : null),
        shellAlone: vi.fn(async () => false)
      },
      record.provider,
      record.providerHandleChain.at(-1)?.handle.nativeId ?? ''
    )
  )
  await host.close(SESSION, 'evict')
  await host.revealSession(SESSION)
  const before = acquire.mock.calls.length
  expect((await rejection(await send('unknown physical terminal')))?.rejection).toMatchObject({
    kind: 'conversationOpenInTerminal'
  })
  expect(acquire).toHaveBeenCalledTimes(before)
  terminalExists = false
  const id = await send('saved note only')
  await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(before + 1))
  await vi.waitFor(async () =>
    expect(
      (await host.journalSnapshot(SESSION)).submissions.find((s) => s.clientMessageId === id)
        ?.dispatchState
    ).toBe('accepted')
  )
})

it('preserves the saved OpenCode guard through acquisition and the recorded send', async () => {
  const sessionId = `${SESSION}-opencode`
  const definition = structuredAgentRuntimeRegistration('opencode')?.definition
  if (!definition) {
    throw new Error('OpenCode is not registered')
  }
  const handle = { transport: definition.handleTransport, agent: 'opencode', nativeId: THREAD }
  acquire.mockImplementationOnce(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4243, processStartTimeMs: NOW, spawnToken },
    acquisitionGeneration: `generation-${fence}`,
    link: {
      linkId: `link-${fence}`,
      handle,
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  const params = hostTestAttachParams(null, {
    provider: 'opencode',
    agent: 'opencode',
    accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } },
    providerHandle: undefined
  })
  params.envelope.sessionId = sessionId
  params.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
    method: 'agentSession.attach',
    sessionId,
    fields: attachFingerprintFields(params)
  })
  const attached = await host.attach(CALLER, params)
  expect(attached).toMatchObject({ ok: true })
  await host.close(sessionId, 'evict')
  const saved: SleepingAgentSessionRecord = {
    paneKey: 'slept',
    worktreeId: 'workspace-1',
    agent: 'opencode',
    providerSession: { key: 'session_id', id: THREAD },
    prompt: '',
    state: 'done',
    origin: 'worktree-sleep',
    capturedAt: 1,
    updatedAt: 1
  }
  assertNoTerminalWriter.mockImplementation((record) =>
    assertCliConversationWritersExited(
      {
        saved: () => [saved],
        rows: () => [],
        links: () => [],
        observation: () => null,
        sleeping: () => true,
        terminal: () => null,
        shellAlone: vi.fn(async () => false)
      },
      record.provider,
      record.providerHandleChain.at(-1)?.handle.nativeId ?? ''
    )
  )
  await host.revealSession(sessionId)
  const before = acquire.mock.calls.length
  const rejected = await rejection(await send('resume saved OpenCode', sessionId), sessionId)
  expect(rejected?.rejection).toMatchObject({ kind: 'conversationOpenInTerminal' })
  expect(rejected?.reason).toBe(
    'OpenCode is already running this conversation in another terminal. Quit OpenCode there or close that terminal to continue here.'
  )
  expect(acquire).toHaveBeenCalledTimes(before)
  expect(store.getRecord(sessionId)?.lease.reservedSpawnToken).toBeNull()
})

it.each([10, 100])(
  'drives acquisition through the real census for %i matching/unrelated panes',
  async (size) => {
    let enumerated = 0
    const saved: Record<string, SleepingAgentSessionRecord> = Object.fromEntries(
      Array.from({ length: size }, (_, index) => [
        `pane-${index}`,
        {
          paneKey: `pane-${index}`,
          worktreeId: 'workspace-1',
          agent: 'codex' as const,
          providerSession: { key: 'session_id' as const, id: THREAD },
          state: 'done' as const,
          prompt: '',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live' as const
        }
      ])
    )
    const population = new Proxy(saved, {
      ownKeys(target) {
        const keys = Reflect.ownKeys(target)
        enumerated += keys.length
        return keys
      }
    })
    let rowVisits = 0
    let linkVisits = 0
    const rows = Array.from({ length: size }, (_, index) => ({
      paneKey: `unrelated-${index}`,
      connectionId: null,
      agentType: 'codex',
      providerSession: { key: 'session_id' as const, id: 'unrelated' },
      state: 'done' as const,
      prompt: '',
      receivedAt: 1,
      stateStartedAt: 1
    }))
    const links = rows.map(() => ({
      agent: 'codex',
      id: 'unrelated',
      paneOwned: true,
      worktreeId: 'workspace-1',
      terminal: () => null
    }))
    rows.forEach((row, index) =>
      Object.defineProperty(rows, index, {
        configurable: true,
        enumerable: true,
        get: () => {
          rowVisits += 1
          return row
        }
      })
    )
    links.forEach((link, index) =>
      Object.defineProperty(links, index, {
        configurable: true,
        enumerable: true,
        get: () => {
          linkVisits += 1
          return link
        }
      })
    )
    rowVisits = 0
    const shell = [{ pid: 10, ppid: 1, stat: 'Ss+', command: '/bin/zsh' }]
    physicalSnapshot.mockResolvedValue(shell)
    const physical = vi.fn(() => posixCliWriterShellAlone(10))
    assertNoTerminalWriter.mockImplementation((record) =>
      assertCliConversationWritersExited(
        {
          saved: () => Object.values(population),
          rows: () => rows,
          links: () => links,
          observation: () => null,
          sleeping: () => false,
          terminal: () => ({ pane: { ptyId: 'shell', incarnationId: 'i1', identity: 'shell:i1' } }),
          shellAlone: physical
        },
        record.provider,
        record.providerHandleChain.at(-1)?.handle.nativeId ?? ''
      )
    )
    const start = async () => {
      await host.close(SESSION, 'evict')
      await host.revealSession(SESSION)
      const before = acquire.mock.calls.length
      await send('acquire after census')
      await vi.waitFor(() => expect(acquire.mock.calls.length).toBe(before + 1))
    }
    for (const record of Object.values(saved)) {
      record.providerSession.id = 'unrelated'
    }
    await start()
    expect([enumerated, physical.mock.calls.length]).toEqual([2 * size, 0])
    expect([rowVisits, linkVisits]).toEqual([size, size])
    for (const record of Object.values(saved)) {
      record.providerSession.id = THREAD
    }
    enumerated = 0
    rowVisits = 0
    linkVisits = 0
    await start()
    // Across each physical await, existing saved-membership and final coverage revalidate the population.
    expect(enumerated).toBe((6 * size + 2) * size)
    expect([rowVisits, linkVisits]).toEqual([(4 * size + 1) * size, size])
    expect(physical).toHaveBeenCalledTimes(size)
    expect(physicalSnapshot).toHaveBeenCalledTimes(size)

    await host.close(SESSION, 'evict')
    await host.revealSession(SESSION)
    physicalSnapshot.mockResolvedValue([
      ...shell,
      { pid: 11, ppid: 10, stat: 'T', command: 'codex' }
    ])
    physical.mockClear()
    const before = acquire.mock.calls.length
    await rejection(await send('live terminal witness'))
    expect(acquire).toHaveBeenCalledTimes(before)
    expect(physical).toHaveBeenCalledTimes(1)

    let finish = () => {}
    physicalSnapshot.mockResolvedValue(shell)
    physicalSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(shell)
        })
    )
    physical.mockClear()
    await send('cancel during physical proof')
    await vi.waitFor(() => expect(physical).toHaveBeenCalledTimes(1))
    const closed = host.close(SESSION, 'evict')
    finish()
    await closed
    await assertNoTerminalWriter.mock.results.at(-1)?.value
    // Closing prevents the late spawn; this inherited census still finishes every physical proof.
    expect(physical).toHaveBeenCalledTimes(size)
    expect(acquire).toHaveBeenCalledTimes(before)
    physicalSnapshot.mockResolvedValue(shell)
    enumerated = 0
    await host.revealSession(SESSION)
    await send('successful successor')
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(before + 1))
    expect(enumerated).toBeLessThanOrEqual((6 * size + 2) * size)
  }
)
