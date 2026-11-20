import { OrcaRuntimeService } from '../../../../runtime/orca-runtime'
import { forkTestSource } from './structured-agent-session-fork.test-fixture'
import { handleStructuredAgentSessionCreate } from '../../../../runtime/rpc/methods/structured-sessions/creation/structured-agent-session-create-handler'
import { afterEach, expect, it, vi } from 'vitest'
import { createRestTestRig } from '../../host/testing/structured-agent-session-rest-test-rig.test-fixture'
import { setStructuredAgentSessionHost } from '../../host/structured-agent-session-registry'
import { withTestAgentSessionDatabase } from '../../../../runtime/agent-session/records/agent-session-record-store-persistence.test-fixture'

afterEach(() => {
  setStructuredAgentSessionHost(null)
  vi.restoreAllMocks()
})

it('reopens a forked chat at the epoch its fork installed', async () => {
  const rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  try {
    const test = forkTestSource(rig)
    const getRecord = rig.store.getRecord.bind(rig.store)
    const requireWritable = rig.store.requireWritableRecord.bind(rig.store)
    const selectWritable = rig.store.selectWritableRecord.bind(rig.store)
    const forkBoundary = rig.host.forkBoundary.bind(rig.host)
    vi.spyOn(rig.store, 'getRecord').mockImplementation((id) =>
      id === 'source-chat' ? test.record : getRecord(id)
    )
    vi.spyOn(rig.store, 'selectWritableRecord').mockImplementation((id) =>
      id === 'source-chat' ? { kind: 'writable', record: test.record } : selectWritable(id)
    )
    vi.spyOn(rig.store, 'requireWritableRecord').mockImplementation((id) =>
      id === 'source-chat' ? test.record : requireWritable(id)
    )
    vi.spyOn(rig.host, 'forkBoundary').mockImplementation((id, ...rest) =>
      id === 'source-chat' ? test.host.forkBoundary(id, ...rest) : forkBoundary(id, ...rest)
    )
    const capabilities = rig.host.deps.agents.capabilities.bind(rig.host.deps.agents)
    vi.spyOn(rig.host.deps.agents, 'capabilities').mockImplementation((agent) => {
      const supported = capabilities(agent)
      return supported ? { ...supported, fork: 'checkpoint' } : null
    })
    rig.host.deps.adapter.copyConversation = test.copy
    setStructuredAgentSessionHost(rig.host)
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'resolveStructuredAgentSessionLocation').mockResolvedValue(
      test.record.location
    )
    vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockResolvedValue(undefined)
    expect(
      await handleStructuredAgentSessionCreate(test.intent, { runtime, clientId: 'device-1' })
    ).toMatchObject({ ok: true, value: { sessionId: 'codex_independent_child' } })
    const installed = await withTestAgentSessionDatabase(rig.root, (db) =>
      String(
        db
          .prepare('SELECT epoch FROM journal_chat_state WHERE session_id=?')
          .get('codex_independent_child')?.epoch
      )
    )
    const child = rig.store.getRecord('codex_independent_child')!
    const reopened = await rig.host.deps.journalDatabase.openSession({
      sessionId: child.sessionId,
      workspaceId: child.location.workspaceId,
      hostId: 'host',
      agent: 'codex',
      providerHandle: child.providerHandleChain.at(-1)!.handle
    })
    expect(reopened.target.epoch).toBe(installed)
  } finally {
    await rig.dispose()
  }
})
