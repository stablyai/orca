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
import { retireChatForAdmittedTerminalLaunch } from '../../runtime/session-tabs/structured-session-terminal-launch-retirement'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { agentSessionLeaseOwnerVerdict } from '../../../shared/agent-session-lease-adjudication'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import {
  AgentSessionAcquisitionRefusal,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
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
const open = vi.fn<StructuredAgentSessionAdapter['open']>(async () => ({
  reportedOptions: { model: '' }
}))
const closeSession = vi.fn<NonNullable<StructuredAgentSessionAdapter['closeSession']>>()
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
  open.mockClear()
  closeSession.mockReset().mockResolvedValue(true)
  assertNoTerminalWriter.mockReset().mockImplementation(async () => {
    if (terminalWriting) {
      throw agentSessionRefusalError('agent_session_conflict', {
        reason: 'conversationHeldElsewhere'
      })
    }
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire,
      dispatch: vi.fn(async () => ({
        state: 'accepted' as const,
        providerIdentity: { provider: 'codex' as const, threadId: THREAD, turnId: 't', ordinal: 1 }
      })),
      closeSession,
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined),
      open
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
  setStructuredAgentSessionHost(null)
  await host.flushAllStreamedEvents()
  closeTestJournalHostDatabase(root)
  await rm(root, { recursive: true, force: true })
})

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

async function rejection(id: string) {
  await vi.waitFor(
    async () =>
      expect(
        (await host.journalSnapshot(SESSION)).submissions.find((s) => s.clientMessageId === id)
          ?.dispatchState
      ).toBe('rejected'),
    { timeout: 10_000 }
  )
  return (await host.journalSnapshot(SESSION)).submissions.find((s) => s.clientMessageId === id)
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
  expect(first?.reason).toContain('has exited in its terminal')
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

// The switch is idle-only and proves the stop; subsequent sends use ordinary G-acquire.
it('switches an idle chat to its terminal and a racing send starts no second writer', async () => {
  const order: string[] = []
  closeSession.mockImplementation(async () => {
    order.push('stop')
    return true
  })
  await host.switchToTerminal(SESSION)
  expect(order).toEqual(['stop'])
  terminalWriting = true
  expect(agentSessionLeaseOwnerVerdict(store.getRecord(SESSION)!.lease)).toBe('exited')
  const spawnsBefore = acquire.mock.calls.length
  const raced = await rejection(await send('from another window'))
  expect(raced?.rejection).toMatchObject({ kind: 'conversationOpenInTerminal' })
  expect(acquire.mock.calls.length).toBe(spawnsBefore)
})

it('refuses a switch while the chat is starting, without aborting that start', async () => {
  await host.close(SESSION, 'evict')
  let release = (): void => undefined
  const started = new Promise<void>((resolve) => {
    release = resolve
  })
  let signal: AbortSignal | undefined
  acquire.mockImplementationOnce(async (attempt) => {
    signal = attempt.signal
    await started
    return acquire.getMockImplementation()!(attempt)
  })
  await send('starts the agent')
  await vi.waitFor(() => expect(signal).toBeDefined())
  await expect(host.switchToTerminal(SESSION)).rejects.toMatchObject({
    refusal: { details: { reason: 'turnActive' } }
  })
  expect(signal?.aborted).toBe(false)
  release()
})

// Terminal to chat: the chat's agent starts with no send, and only its ready provider is success.
it('starts the chat that holds the conversation for a switch from its terminal', async () => {
  await host.close(SESSION, 'evict')
  terminalWriting = true
  const spawnsBefore = acquire.mock.calls.length
  expect(await host.switchToChat(SESSION)).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'conversationOpenInTerminal' } }
  })
  expect(acquire.mock.calls.length).toBe(spawnsBefore)

  terminalWriting = false
  open.mockRejectedValueOnce(
    new AgentSessionAcquisitionRefusal('thread has an active writer', 'conversationOpenElsewhere')
  )
  expect(await host.switchToChat(SESSION)).toMatchObject({
    ok: false,
    refusal: {
      code: 'agent_session_operation_invalid',
      details: { reason: 'conversationOpenElsewhere' }
    }
  })

  expect(await host.switchToChat(SESSION)).toEqual({ ok: true })
  expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
  expect(vi.mocked(host.deps.adapter.dispatch)).not.toHaveBeenCalled()
})

// A delayed admitted launch retires presentation only, even if a later send already restarted the chat.
it('retires only after an explicit admitted launch without stopping a later native child', async () => {
  setStructuredAgentSessionHost(host)
  await host.setSessionTabVisibility(SESSION, true)
  await host.switchToTerminal(SESSION)
  const runtime = { retireStructuredAgentSessionTabFromSnapshot: vi.fn(() => true) }
  const args = {
    resumeOrigin: 'switch',
    worktreeId: store.getRecord(SESSION)?.location.workspaceId
  }
  const decision = {
    agent: 'codex' as const,
    providerSession: { key: 'session_id' as const, id: THREAD },
    verdict: 'admitted' as const
  }
  for (const result of [
    {},
    { savedResumeDecision: { ...decision, verdict: 'unverifiable' as const } },
    { savedResumeDecision: decision, isReattach: true }
  ]) {
    await retireChatForAdmittedTerminalLaunch(runtime, args, result)
    expect(store.getVisibleSessionTabIndex()?.sessionIds).toContain(SESSION)
  }
  expect(await host.switchToChat(SESSION)).toEqual({ ok: true })
  const laterChild = host.collaboratorsForTests().sessions.get(SESSION)?.child
  const closes = closeSession.mock.calls.length
  await retireChatForAdmittedTerminalLaunch(runtime, args, { savedResumeDecision: decision })
  expect(store.getVisibleSessionTabIndex()?.sessionIds).not.toContain(SESSION)
  expect(runtime.retireStructuredAgentSessionTabFromSnapshot).toHaveBeenCalledWith(SESSION)
  expect(host.collaboratorsForTests().sessions.get(SESSION)?.child).toBe(laterChild)
  expect(closeSession).toHaveBeenCalledTimes(closes)
})

it.each(['ready', 'failed', 'closed', 'replaced'] as const)(
  'awaits provider open for the selected child, whose result is %s',
  async (ending) => {
    await host.close(SESSION, 'evict')
    const held = Promise.withResolvers<void>()
    open.mockImplementationOnce(async () => {
      await held.promise
      if (ending === 'failed') {
        throw new AgentSessionAcquisitionRefusal('provider failed')
      }
      return { reportedOptions: { model: '' } }
    })
    let settled = false
    const switching = host.switchToChat(SESSION).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    const child = host.collaboratorsForTests().sessions.get(SESSION)?.child
    expect(child?.phase).toBe('starting')
    expect(settled).toBe(false)
    let replacement = child
    if (ending === 'closed' || ending === 'replaced') {
      await host.close(SESSION, 'evict')
    }
    if (ending === 'replaced') {
      expect(await host.switchToChat(SESSION)).toEqual({ ok: true })
      replacement = host.collaboratorsForTests().sessions.get(SESSION)?.child
      expect(replacement?.generation).not.toBe(child?.generation)
    }
    held.resolve()
    expect(await switching).toMatchObject({ ok: ending === 'ready' })
    expect(vi.mocked(host.deps.adapter.dispatch)).not.toHaveBeenCalled()
    if (ending === 'replaced') {
      expect(host.collaboratorsForTests().sessions.get(SESSION)?.child).toBe(replacement)
    }
    if (ending === 'closed') {
      expect(await host.switchToChat(SESSION)).toEqual({ ok: true })
      expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.generation).not.toBe(
        child?.generation
      )
    }
  }
)

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
