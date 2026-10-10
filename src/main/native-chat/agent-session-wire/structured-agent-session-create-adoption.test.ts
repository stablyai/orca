import { writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import {
  createTestParams,
  stopCreatedChat,
  CREATE_TEST_CALLER as CALLER
} from './structured-agent-session-create-test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'

let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
})
afterEach(async () => {
  await rig.dispose()
  vi.restoreAllMocks()
})

async function adoptedParams(history = 'adopted history', threadId = THREAD) {
  const transcriptPath = join(rig.root, 'rollout.jsonl')
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: threadId, timestamp: '2026-09-06T18:00:00.000Z', cwd: rig.root }
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-09-06T18:00:01.000Z',
        payload: { type: 'message', role: 'user', content: history }
      })
    ].join('\n')
  )
  return createTestParams(undefined, {
    adopt: { providerHandle: { kind: 'codex', threadId }, transcriptPath }
  })
}

function anotherSession(params: AgentSessionAttachParams): AgentSessionAttachParams {
  return createTestParams(undefined, {
    ...params,
    envelope: {
      ...params.envelope,
      sessionId: 'session-second',
      clientOperationId: hostTestOperationId()
    }
  })
}

it('imports adoption at rest and resumes its original provider identity after its source disappears', async () => {
  const params = await adoptedParams()
  const history = vi.fn(async () => null)
  rig.host.deps.adapter.providerHistoryWindow = history
  expect(await rig.host.create(CALLER, params)).toMatchObject({
    ok: true,
    value: {
      page: {
        items: expect.arrayContaining([
          expect.objectContaining({
            body: expect.objectContaining({ blocks: [{ type: 'text', text: 'adopted history' }] })
          })
        ])
      }
    }
  })
  expect(rig.store.getRecord(SESSION)?.providerHandleChain).toMatchObject([
    { origin: 'adopted', mintedAtFence: 1, handle: { nativeId: THREAD } }
  ])
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  expect(history).not.toHaveBeenCalled()
  await rm(join(rig.root, 'rollout.jsonl'))
  expect(
    await rig.host.create(CALLER, {
      ...params,
      accountHome: { variable: 'CODEX_HOME', path: '/drifted/account' },
      adopt: { providerHandle: { kind: 'codex', threadId: THREAD } }
    })
  ).toMatchObject({ ok: true, replayed: true })
  expect(await rig.host.send(CALLER, restTestSend('new work'))).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  expect(rig.adapter.acquire).toHaveBeenCalledWith(
    expect.objectContaining({
      identity: expect.objectContaining({
        providerHandle: expect.objectContaining({ nativeId: THREAD })
      })
    })
  )
  expect(history).toHaveBeenCalledOnce()
  expect(history.mock.invocationCallOrder[0]).toBeLessThan(
    rig.adapter.acquire.mock.invocationCallOrder[0]
  )
  expect(rig.store.getRecord(SESSION)?.accountHome).toEqual(params.accountHome)
})

it('refuses concurrent adoption of a provider conversation by another session', async () => {
  const params = await adoptedParams()
  const results = await Promise.all([
    rig.host.create(CALLER, params),
    rig.host.create(CALLER, anotherSession(params))
  ])
  expect(results.filter((result) => result.ok)).toHaveLength(1)
  expect(results.filter((result) => !result.ok)).toMatchObject([
    {
      refusal: { code: 'agent_session_conflict', details: { reason: 'conversationHeldElsewhere' } }
    }
  ])
  expect(rig.store.listRecords()).toHaveLength(1)
  expect(rig.store.listOperationRows()).toHaveLength(1)
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it('refuses concurrent founding under a tab another chat already owns', async () => {
  const params = createTestParams(undefined, { surfaceTabId: 'reserved-chat-tab' })
  const results = await Promise.all([
    rig.host.create(CALLER, params),
    rig.host.create(CALLER, anotherSession(params))
  ])
  expect(results.filter((result) => result.ok)).toHaveLength(1)
  expect(results.filter((result) => !result.ok)).toMatchObject([
    { refusal: { code: 'agent_session_conflict', details: { reason: 'tabIdTaken' } } }
  ])
  expect(rig.store.listVisibleSessionIds()).toHaveLength(1)
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it('validates adoption history before founding anything', async () => {
  const params = await adoptedParams()
  await writeFile(join(rig.root, 'rollout.jsonl'), 'not a transcript\n')
  expect(await rig.host.create(CALLER, params)).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_identity_required' }
  })
  expect(rig.store.listRecords()).toEqual([])
  expect(rig.store.listOperationRows()).toEqual([])
})

it('does not found a record whose account namespace its agent cannot drive', async () => {
  const params = createTestParams(undefined, {
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/wrong/account' }
  })
  expect(await rig.host.create(CALLER, params)).toMatchObject({
    ok: false,
    refusal: { code: 'structured_agent_session_unsupported' }
  })
  expect(rig.store.listRecords()).toEqual([])
  expect(rig.store.listOperationRows()).toEqual([])
})

it.each([
  { executionHostId: 'local', wslDistro: null },
  { executionHostId: 'ssh:host-1', wslDistro: null },
  { executionHostId: 'local', wslDistro: 'Ubuntu' },
  { executionHostId: 'runtime:paired-host', wslDistro: null }
] as const)(
  'preserves folder execution identity at rest: $executionHostId $wslDistro',
  async (location) => {
    const params = createTestParams(undefined, {
      location: { ...location, workspaceId: 'folder-1', workspaceKind: 'folder' }
    })
    expect(await rig.host.create(CALLER, params)).toMatchObject({ ok: true })
    expect(rig.store.getRecord(SESSION)?.location).toEqual(params.location)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  }
)

it('pins the host-resolved directory of a floating chat before any acquire', async () => {
  const params = createTestParams(undefined, {
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
      workspaceKind: 'folder'
    }
  })
  expect(await rig.host.create(CALLER, params, { hostLaunchDirectory: rig.root })).toMatchObject({
    ok: true
  })
  expect(rig.store.getRecord(SESSION)?.launchDirectory).toBe(rig.root)
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it.each(['adopted', 'blank'] as const)(
  'retries a rolled-back create with only the new %s history',
  async (nextSource) => {
    const first = { clientMessageId: hostTestOperationId(), body: hostTestMessage('first attempt') }
    const adopted = await adoptedParams('old imported history')
    const db = openTestJournalHostDatabase(rig.root).db
    db.exec(
      `CREATE TRIGGER refuse_first BEFORE INSERT ON journal_rows WHEN NEW.row_json LIKE '%"kind":"submission"%' BEGIN SELECT RAISE(ABORT, 'simulated first write failure'); END`
    )
    expect(
      await rig.host.create(CALLER, createTestParams(first, adopted), { firstMessage: first })
    ).toMatchObject({ ok: false })
    expect(rig.store.getRecord(SESSION)).toBeNull()
    expect(rig.store.listOperationRows()).toEqual([])
    db.exec('DROP TRIGGER refuse_first')
    const next = { clientMessageId: hostTestOperationId(), body: hostTestMessage('next attempt') }
    const nextParams =
      nextSource === 'adopted'
        ? await adoptedParams('new imported history', '019fd532-7c11-7a90-b6de-4e1a2c3d5f61')
        : createTestParams()
    let stopping: ReturnType<typeof stopCreatedChat> | undefined
    const result = await rig.host.create(
      CALLER,
      createTestParams(next, {
        ...nextParams,
        envelope: { ...nextParams.envelope, clientOperationId: hostTestOperationId() }
      }),
      {
        firstMessage: next,
        publishTab: async () => {
          stopping = stopCreatedChat(rig.host)
        }
      }
    )
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) {
      throw new Error('retry create failed')
    }
    const history = (text: string) =>
      expect.objectContaining({
        body: expect.objectContaining({ blocks: [{ type: 'text', text }] })
      })
    expect(result.value.page.items).not.toEqual(
      expect.arrayContaining([history('old imported history')])
    )
    if (nextSource === 'adopted') {
      expect(result.value.page.items).toEqual(
        expect.arrayContaining([history('new imported history')])
      )
    }
    expect(await stopping).toMatchObject({ ok: true })
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  }
)
