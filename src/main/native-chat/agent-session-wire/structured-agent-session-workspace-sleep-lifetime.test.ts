import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  adapterAtPublishFor,
  fakeClaude,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { expect, it, vi } from 'vitest'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import {
  createRestTestRig,
  foundRestTestChat,
  IDLE_MS
} from './structured-agent-session-rest-test-rig'
import {
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState,
  attachParams
} from './structured-agent-session-host-test-harness'
import type { StructuredAgentSessionProviderOpen } from './structured-agent-session-provider-open-contract'

it('omits an unverified stop superseded by a newer send while retaining a sibling receipt', async () => {
  const { host, store, acquire } = hostTestState()
  const record = await attach()
  if (!record) {
    throw new Error('attach did not produce a record')
  }
  const sibling = 'session-beta'
  const siblingRecord = { ...record, sessionId: sibling }
  const getRecord = store.getRecord.bind(store)
  vi.spyOn(store, 'listRecords').mockReturnValue([record, siblingRecord])
  vi.spyOn(store, 'getRecord').mockImplementation((id) =>
    id === sibling ? siblingRecord : getRecord(id)
  )
  host.deps.adapter.closeSession = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)

  let failedStopDone: () => void = () => undefined
  const failedStop = new Promise<void>((resolve) => {
    failedStopDone = resolve
  })
  let releaseSibling: () => void = () => undefined
  const slowSibling = new Promise<void>((resolve) => {
    releaseSibling = resolve
  })
  const close = host['lifetime'].closeForWorkspaceSleep
  vi.spyOn(host['lifetime'], 'closeForWorkspaceSleep').mockImplementation(async (...args) => {
    if (args[0] === sibling) {
      await slowSibling
      return { fence: siblingRecord.lease.runtimeFence, stopped: true, admittedSends: 0 }
    }
    const result = await close(...args)
    failedStopDone()
    return result
  })

  const sleeping = host.sleepWorkspace('workspace-1')
  try {
    await failedStop
    const body = hostTestMessage('resume after unverified stop')
    expect(
      await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2))
  } finally {
    releaseSibling()
  }
  expect(await sleeping).toEqual({ stoppedSessionIds: [sibling] })
})

it.each(['persist', 'root-exit', 'retry', 'successor', 'root-successor'] as const)(
  'retains failed-acquisition exit proof across %s',
  async (mode) => {
    const { host: original, store, root } = hostTestState()
    const claude = fakeClaude({
      unprovenCloseVerdict: { root: 'unverifiable', tree: 'unverifiable' }
    })
    const open = claude.openConnection
    claude.openConnection = async (...args) => {
      const connection = await open(...args)
      claude.connections[0].closed = true
      return connection
    }
    const adapter = adapterAtPublishFor(claude)
    const agents = claudeAndCodexAgents(adapter)
    const router = new StructuredAgentSessionAdapterRouter(agents, async () => {})
    const host = new StructuredAgentSessionHost({ ...original.deps, agents, adapter: router })
    replaceHostTestState({ host, store })
    await expect(
      host.attach(
        CALLER,
        attachParams({
          agent: 'claude',
          provider: 'claude',
          accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude' },
          providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
        })
      )
    ).rejects.toThrow('agent_session_acquisition_exit_unproven')
    expect(router.hasOwnedAcquisition('session-alpha')).toBe(true)
    expect(store.getRecord('session-alpha')?.lease.deathEvidence).toBeNull()
    const connection = claude.connections[0]
    connection.close = vi.fn(async () => mode !== 'root-exit' && mode !== 'root-successor')
    if (mode === 'root-exit' || mode === 'root-successor') {
      connection.exitVerdict = { root: 'exited', tree: 'unverifiable' }
    }
    if (mode === 'retry' || mode === 'successor') {
      vi.spyOn(store, 'transitionHandoff').mockRejectedValueOnce(new Error('evidence write failed'))
    }
    expect(await host.sleepWorkspace('workspace-1')).toEqual({
      stoppedSessionIds: ['session-alpha']
    })
    if (mode === 'retry' || mode === 'successor') {
      expect(store.getRecord('session-alpha')?.lease.deathEvidence).toBeNull()
      expect(router.stoppedAcquisition('session-alpha')).toBeDefined()
    }
    if (mode === 'successor' || mode === 'root-successor') {
      const body = hostTestMessage('send after failed exit bookkeeping')
      expect(
        await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
      ).toMatchObject({ ok: true })
      await vi
        .waitFor(() => expect(claude.connections).toHaveLength(2))
        .finally(() => {
          for (const opened of claude.connections) {
            opened.close = async () => true
          }
        })
      claude.connections[1].close = async () => true
      expect(router.stoppedAcquisition('session-alpha')).toBeUndefined()
      expect(store.getRecord('session-alpha')?.lease.deathEvidence).toBeNull()
      return
    }
    expect(await host.sleepWorkspace('workspace-1')).toEqual({
      stoppedSessionIds: ['session-alpha']
    })
    expect(connection.close).toHaveBeenCalledOnce()
    expect(router.stoppedAcquisition('session-alpha')).toBeUndefined()
    const reopened = await openTestAgentSessionRecordStore(root)
    const restarted = new StructuredAgentSessionHost({ ...host.deps, store: reopened })
    expect(reopened.getRecord('session-alpha')?.lease.deathEvidence).toMatchObject({
      kind: 'exit-observed',
      ownerFence: 1
    })
    await restarted.restoreReadableSessions()
    expect(await restarted.sleepWorkspace('workspace-1')).toEqual({
      stoppedSessionIds: ['session-alpha']
    })
  }
)

it('keeps a send admitted after the host Sleep close alive', async () => {
  const { host, acquire, dispatch } = hostTestState()
  await attach()
  const close = vi.fn(async () => true)
  host.deps.adapter.closeSession = close
  const sleeping = host.sleepWorkspace('workspace-1')
  const body = hostTestMessage('phone send after Sleep admission')
  expect(
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).toMatchObject({ ok: true })
  await sleeping
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  expect(acquire).toHaveBeenCalledTimes(2)
  expect(close).toHaveBeenCalledOnce()
  expect(host.hasSession('session-alpha')).toBe(true)
})

it('keeps Sleep through history reopen and replay, and clears it atomically with a new send', async () => {
  const { host, store, dispatch, root } = hostTestState()
  await attach()
  const send = async (text: string) => {
    const body = hostTestMessage(text)
    const params = { envelope: envelope('agentSession.send', { body }), body }
    expect(await host.send(CALLER, params)).toMatchObject({ ok: true })
    return params
  }
  expect(await host.sleepWorkspace('workspace-1')).toEqual({ stoppedSessionIds: ['session-alpha'] })
  expect(store.getRecord('session-alpha')?.sleptAt).toBeUndefined()
  const previous = await send('after the move')
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  await host.sleepWorkspace('workspace-1')
  expect(host.hasSession(SESSION)).toBe(false)
  const close = host['lifetime'].closeForWorkspaceSleep
  vi.spyOn(host['lifetime'], 'closeForWorkspaceSleep').mockImplementation(async (...args) => {
    const stopped = await close(...args)
    expect(await host.history({ sessionId: SESSION, direction: 'tail' })).toMatchObject({
      ok: true
    })
    return stopped
  })
  expect(await host.sleepWorkspace('workspace-1', true)).toEqual({
    stoppedSessionIds: ['session-alpha']
  })
  const sleptAt = store.getRecord('session-alpha')?.sleptAt
  expect(sleptAt).toEqual(expect.any(Number))
  expect(await host.send(CALLER, previous)).toMatchObject({ ok: true, replayed: true })
  expect(store.getRecord('session-alpha')?.sleptAt).toBe(sleptAt)

  const outcomeReceipt = store.operationOutcomeReceipt.bind(store)
  let stagedAwake = false
  vi.spyOn(store, 'operationOutcomeReceipt').mockImplementationOnce((args) => {
    const receipt = outcomeReceipt(args)
    return {
      ...receipt,
      write: (db, row) => {
        receipt.write(db, row)
        stagedAwake =
          db.isTransaction &&
          db
            .prepare(
              "SELECT json_extract(record_json, '$.sleptAt') AS sleptAt FROM agent_session_records WHERE session_id = ?"
            )
            .get(SESSION)?.sleptAt === null
        throw new Error('transaction failed before commit')
      }
    }
  })
  const body = hostTestMessage('rolled back send')
  const rolledBack = { envelope: envelope('agentSession.send', { body }), body }
  expect(await host.send(CALLER, rolledBack)).toMatchObject({ ok: false })
  expect(stagedAwake).toBe(true)
  expect((await openTestAgentSessionRecordStore(root)).getRecord(SESSION)?.sleptAt).toBe(sleptAt)
  expect(
    host['sessions']
      .get(SESSION)
      ?.journal.submissions()
      .some((send) => send.clientMessageId === rolledBack.envelope.clientOperationId)
  ).toBe(false)

  await send('wake up')
  expect((await openTestAgentSessionRecordStore(root)).getRecord(SESSION)?.sleptAt).toBeUndefined()
})

it('returns the receipt for a stopped child whose provider reports its own end', async () => {
  const { host, store } = hostTestState()
  await attach()
  await host['tasks'].drainAttaches()
  // Match adapters: report close onto the chat lane before returning.
  host.deps.adapter.closeSession = vi.fn(async (sessionId: string) => {
    const child = host['sessions'].get(sessionId)?.child
    if (child?.generation) {
      void host.handleAdapterEvent({
        type: 'ended',
        reason: 'closed',
        cause: 'requested-close',
        sessionId,
        fence: child.fence,
        acquisitionGeneration: child.generation,
        processExit: { root: 'exited', workload: 'unverifiable' }
      })
    }
    return true
  })
  const reported = vi.spyOn(host, 'handleAdapterEvent')

  expect(await host.sleepWorkspace('workspace-1')).toEqual({ stoppedSessionIds: [SESSION] })
  expect(reported).toHaveBeenCalledWith(expect.objectContaining({ cause: 'requested-close' }))
  expect([store.getRecord(SESSION) !== null, host.hasSession(SESSION)]).toEqual([true, false])
  expect(await host.sleepWorkspace('other-workspace')).toEqual({ stoppedSessionIds: [] })
})

it('omits an unproven workspace child from the stop receipt', async () => {
  const { host, store } = hostTestState()
  await attach()
  host.deps.adapter.closeSession = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)

  expect(await host.sleepWorkspace('workspace-1', true)).toEqual({
    stoppedSessionIds: [],
    failures: [{ sessionId: SESSION, reason: 'stop-unverifiable' }]
  })
  expect(store.getRecord(SESSION)).not.toBeNull()
  expect(store.getRecord(SESSION)?.sleptAt).toBeUndefined()
})

it.each(['running', 'failed'] as const)('keeps a newer %s send awake', async (state) => {
  const { host, acquire, store } = hostTestState()
  await attach()
  host.deps.adapter.closeSession = vi.fn(async () => true)
  await vi.waitFor(() => expect(host['conversationDelivery'].loop.isRunning(SESSION)).toBe(false))
  const close = host['lifetime'].closeForWorkspaceSleep
  vi.spyOn(host['lifetime'], 'closeForWorkspaceSleep').mockImplementation(async (...args) => {
    const result = await close(...args)
    if (state === 'failed') {
      acquire.mockRejectedValueOnce(new Error('provider unavailable'))
    }
    const body = hostTestMessage('newer send')
    const sent = host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    expect(await sent).toMatchObject({ ok: true })
    if (state === 'failed') {
      await vi.waitFor(() => {
        expect(host['runtimeState'].startFlights.has(SESSION)).toBe(false)
        expect(host['conversationDelivery'].loop.isRunning(SESSION)).toBe(false)
        expect(host['sessions'].get(SESSION)?.journal.pendingSubmissions()).toEqual([])
      })
    }
    return result
  })

  expect(await host.sleepWorkspace('workspace-1', true)).toEqual({ stoppedSessionIds: [] })
  expect(store.getRecord(SESSION)?.sleptAt).toBeUndefined()
})

// Startup runs outside serialization; Sleep must reach it through its abort.
it('stops an agent that is still starting', async () => {
  const { host, acquire } = hostTestState()
  await attach()
  const closeSession = vi.fn(async () => true)
  host.deps.adapter.closeSession = closeSession
  expect(await host.sleepWorkspace('workspace-1')).toEqual({ stoppedSessionIds: [SESSION] })
  let opening = false
  host.deps.adapter.open = vi.fn<StructuredAgentSessionProviderOpen>(async ({ signal }) => {
    opening = true
    return await new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason))
    )
  })
  const body = hostTestMessage('send while the agent starts')
  expect(
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(opening).toBe(true))
  closeSession.mockClear()

  expect(await host.sleepWorkspace('workspace-1')).toEqual({ stoppedSessionIds: [SESSION] })
  expect(acquire).toHaveBeenCalledTimes(2)
  expect(closeSession).toHaveBeenCalledWith(SESSION, undefined)
  expect(host['runtimeState'].startFlights.has(SESSION)).toBe(false)
  expect(host['sessions'].get(SESSION)?.child ?? null).toBeNull()
})

it('stops an agent whose process is still being acquired', async () => {
  const { host, acquire, store } = hostTestState()
  await attach()
  expect(await host.sleepWorkspace('workspace-1')).toEqual({ stoppedSessionIds: [SESSION] })
  let acquiring = false
  acquire.mockImplementationOnce(async ({ signal }) => {
    acquiring = true
    return await new Promise<never>((_, reject) =>
      signal?.addEventListener('abort', () => reject(signal.reason))
    )
  })
  const body = hostTestMessage('send while the agent is acquired')
  expect(
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(acquiring).toBe(true))

  expect(await host.sleepWorkspace('workspace-1', true)).toEqual({ stoppedSessionIds: [SESSION] })
  expect(store.getRecord(SESSION)?.sleptAt).toEqual(expect.any(Number))
  expect(host['runtimeState'].startFlights.has(SESSION)).toBe(false)
  expect(host['sessions'].get(SESSION)?.child ?? null).toBeNull()
})

it('sleeps only proven ended chats after idle eviction or restart', async () => {
  const rig = await createRestTestRig()
  try {
    await foundRestTestChat(rig)
    rig.clock.now += IDLE_MS + 1
    await vi.waitFor(() => {
      expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION, undefined)
      expect(rig.host.hasSession(SESSION)).toBe(false)
    })
    expect(rig.store.getRecord(SESSION)?.sleptAt).toBeUndefined()
    expect(await rig.host.sleepWorkspace('workspace-1')).toEqual({ stoppedSessionIds: [SESSION] })
    expect(rig.store.getRecord(SESSION)?.sleptAt).toBeUndefined()
    await rig.restart()
    await rig.host.restoreReadableSessions()
    expect(await rig.host.sleepWorkspace('workspace-1')).toEqual({ stoppedSessionIds: [SESSION] })
    const getRecord = rig.store.getRecord.bind(rig.store)
    vi.spyOn(rig.store, 'getRecord').mockImplementation((id) => {
      const record = getRecord(id)
      return record && { ...record, lease: { ...record.lease, deathEvidence: null } }
    })
    expect(await rig.host.sleepWorkspace('workspace-1')).toMatchObject({
      failures: [{ reason: 'stop-unverifiable' }]
    })
  } finally {
    await rig.dispose()
  }
})
