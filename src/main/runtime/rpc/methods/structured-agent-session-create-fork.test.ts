import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { AGENT_SESSION_CODEX_FORK_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import { codexProviderHandle } from '../../../../shared/agent-session-provider-handle-encoding'
import { AgentSessionJournal } from '../../../native-chat/agent-session-journal/journal-store'
import { openTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { HOST_TEST_SESSION as PARENT } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  assistantRow,
  CHILD,
  CHILD_THREAD,
  forkRequest,
  messageTexts,
  providerHistory,
  seedForkParent
} from '../../../native-chat/agent-session-wire/structured-agent-session-fork.test-fixture'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { call } from './structured-agent-session-rpc.test-fixture'

const client = {
  clientId: 'device-1',
  clientKind: 'runtime' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    AGENT_SESSION_CODEX_FORK_RUNTIME_CAPABILITY
  ]
}
let rig: RestTestRig
const fork = vi.fn<NonNullable<StructuredAgentSessionAdapter['forkConversation']>>()
const resolveIntent = vi.fn(async () => {
  throw new Error('A branch must not resolve current global create selections')
})

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  setStructuredAgentSessionHost(rig.host)
  resolveIntent.mockClear()
  fork.mockReset().mockImplementation(async ({ beforeFork, sessionId }) => {
    await beforeFork()
    return {
      providerHandle: codexProviderHandle(CHILD_THREAD),
      items: providerHistory(sessionId, CHILD_THREAD, ['A', 'B'])
    }
  })
  rig.host.deps.adapter.forkConversation = fork
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  vi.restoreAllMocks()
  await rig.dispose()
})

it('creates a complete branch through RPC before publication and replays without its closed parent', async () => {
  const parent = await seedForkParent(rig)
  const input = forkRequest(
    rig,
    assistantRow(parent.snapshot().items, 'B').itemId,
    parent.cursor().epoch
  )
  expect(input).not.toHaveProperty('options')
  expect(input).not.toHaveProperty('accountHome')
  const publish = vi.fn(async () => {
    expect(fork).toHaveBeenCalledOnce()
    expect(rig.store.getRecord(CHILD)?.providerHandleChain.at(-1)?.handle.nativeId).toBe(
      CHILD_THREAD
    )
    const imported = new AgentSessionJournal({
      database: openTestJournalHostDatabase(rig.root),
      identity: {
        sessionId: CHILD,
        workspaceId: 'folder-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle(CHILD_THREAD)
      }
    })
    await imported.open()
    try {
      expect(messageTexts(imported.snapshot().items)).toEqual([
        'question A',
        'answer A',
        'question B',
        'answer B'
      ])
    } finally {
      await imported.close()
    }
  })
  const runtime = {
    resolveStructuredAgentSessionCreateIntent: resolveIntent,
    publishStructuredAgentSessionTab: publish
  }
  expect(await call('agentSession.create', input, client, runtime)).toMatchObject({
    ok: true,
    result: { ok: true, value: { sessionId: CHILD } }
  })
  expect(fork).toHaveBeenCalledWith(expect.objectContaining({ lastTurnId: 'B' }))
  expect(publish).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: 'folder-1', sessionId: CHILD })
  )
  expect(rig.store.getRecord(CHILD)).toMatchObject({
    accountHome: rig.store.getRecord(PARENT)?.accountHome,
    options: { model: 'gpt-parent', effort: 'high' },
    permissionMode: 'ask'
  })
  await rig.host.close(PARENT, 'user-close')
  const requireRecord = rig.store.requireWritableRecord.bind(rig.store)
  const lookup = vi.spyOn(rig.store, 'requireWritableRecord').mockImplementation((sessionId) => {
    if (sessionId === PARENT) {
      throw new Error('The parent is unavailable')
    }
    return requireRecord(sessionId)
  })
  expect(await call('agentSession.create', input, client, runtime)).toMatchObject({
    ok: true,
    result: { ok: true, replayed: true, value: { sessionId: CHILD } }
  })
  expect(lookup).not.toHaveBeenCalledWith(PARENT)
  expect(resolveIntent).not.toHaveBeenCalled()
  expect(fork).toHaveBeenCalledOnce()
  expect(publish).toHaveBeenCalledTimes(2)
})

it('rejects client-selected account paths and option overrides before the fork handler', async () => {
  const parent = await seedForkParent(rig)
  const input = forkRequest(
    rig,
    assistantRow(parent.snapshot().items, 'B').itemId,
    parent.cursor().epoch
  )
  for (const extra of [
    { accountHome: { variable: 'CODEX_HOME', path: '/client/account' } },
    { options: { model: 'client-model' } }
  ]) {
    expect(
      await call('agentSession.create', { ...input, ...extra }, client, {
        resolveStructuredAgentSessionCreateIntent: resolveIntent
      })
    ).toMatchObject({ ok: false })
  }
  expect(fork).not.toHaveBeenCalled()
  expect(resolveIntent).not.toHaveBeenCalled()
  expect(rig.store.getRecord(CHILD)).toBeNull()
})
