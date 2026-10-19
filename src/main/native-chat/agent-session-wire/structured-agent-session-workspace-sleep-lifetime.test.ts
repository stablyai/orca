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
import { hostTestMessage } from './structured-agent-session-host-test-data'
import {
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState,
  attachParams
} from './structured-agent-session-host-test-harness'

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
      return { fence: siblingRecord.lease.runtimeFence, stopped: true }
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
