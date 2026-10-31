import { writeFile, rm } from 'node:fs/promises'
vi.mock('../../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async (original) => {
  const query = await import('../transcript-opencode-sqlite-query')
  return {
    ...(await original<object>()),
    readOpenCodeTranscriptPageViaWorker: query.readOpenCodeTranscriptPage,
    readOpenCodeTranscriptSignalViaWorker: async (args: { dbPath: string; sessionId: string }) =>
      query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId)
  }
})
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { restTestSend } from './structured-agent-session-rest-test-rig'
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
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

import {
  fixture,
  adoptedParams,
  anotherSession
} from './structured-agent-session-create-adoption-contract-test-fixture'

it('imports adoption at rest and resumes its original provider identity after its source disappears', async () => {
  const params = await adoptedParams()
  expect(await fixture.rig.host.create(CALLER, params)).toMatchObject({
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
  expect(fixture.rig.store.getRecord(SESSION)?.providerHandleChain).toMatchObject([
    { origin: 'adopted', mintedAtFence: 1, handle: { nativeId: THREAD } }
  ])
  expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  await rm(join(fixture.rig.root, 'rollout.jsonl'))
  expect(
    await fixture.rig.host.create(CALLER, {
      ...params,
      accountHome: { variable: 'CODEX_HOME', path: '/drifted/account' },
      adopt: { providerHandle: codexProviderHandle(THREAD) }
    })
  ).toMatchObject({ ok: true, replayed: true })
  expect(await fixture.rig.host.send(CALLER, restTestSend('new work'))).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(fixture.rig.adapter.dispatch).toHaveBeenCalledOnce())
  expect(fixture.rig.adapter.acquire).toHaveBeenCalledWith(
    expect.objectContaining({
      identity: expect.objectContaining({
        providerHandle: expect.objectContaining({ nativeId: THREAD })
      })
    })
  )
  expect(fixture.rig.store.getRecord(SESSION)?.accountHome).toEqual(params.accountHome)
})

it('refuses concurrent adoption of a provider conversation by another session', async () => {
  const params = await adoptedParams()
  const results = await Promise.all([
    fixture.rig.host.create(CALLER, params),
    fixture.rig.host.create(CALLER, anotherSession(params))
  ])
  expect(results.filter((result) => result.ok)).toHaveLength(1)
  expect(results.filter((result) => !result.ok)).toMatchObject([
    {
      refusal: {
        code: 'agent_session_conflict',
        details: {
          reason: 'conversationHeldElsewhere',
          owner: { sessionId: expect.any(String), workspaceId: params.location.workspaceId }
        },
        createAttemptRefusedBeforeCommit: true
      }
    }
  ])
  expect(fixture.rig.store.listRecords()).toHaveLength(1)
  expect(fixture.rig.store.listOperationRows()).toHaveLength(1)
  expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
})

it('refuses concurrent founding under a tab another chat already owns', async () => {
  const params = createTestParams(undefined, { surfaceTabId: 'reserved-chat-tab' })
  const results = await Promise.all([
    fixture.rig.host.create(CALLER, params),
    fixture.rig.host.create(CALLER, anotherSession(params))
  ])
  expect(results.filter((result) => result.ok)).toHaveLength(1)
  expect(results.filter((result) => !result.ok)).toMatchObject([
    { refusal: { code: 'agent_session_conflict', details: { reason: 'tabIdTaken' } } }
  ])
  expect(fixture.rig.store.listVisibleSessionIds()).toHaveLength(1)
  expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
})

it.each(['missing', 'empty', 'malformed'] as const)(
  'refuses %s history before founding anything',
  async (source) => {
    const params = await adoptedParams()
    await (source === 'missing'
      ? rm(join(fixture.rig.root, 'rollout.jsonl'))
      : writeFile(
          join(fixture.rig.root, 'rollout.jsonl'),
          source === 'empty' ? '' : '{broken json}\n'
        ))
    expect(await fixture.rig.host.create(CALLER, params)).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_identity_required',
        details: { reason: source === 'empty' ? 'transcriptNotFound' : 'transcriptUnreadable' },
        createAttemptRefusedBeforeCommit: true
      }
    })
    expect(fixture.rig.store.listRecords()).toEqual([])
    expect(fixture.rig.store.listOperationRows()).toEqual([])
  }
)

it('does not found a record whose account namespace its agent cannot drive', async () => {
  const params = createTestParams(undefined, {
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/wrong/account' }
  })
  expect(await fixture.rig.host.create(CALLER, params)).toMatchObject({
    ok: false,
    refusal: { code: 'structured_agent_session_unsupported' }
  })
  expect(fixture.rig.store.listRecords()).toEqual([])
  expect(fixture.rig.store.listOperationRows()).toEqual([])
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
    expect(await fixture.rig.host.create(CALLER, params)).toMatchObject({ ok: true })
    expect(fixture.rig.store.getRecord(SESSION)?.location).toEqual(params.location)
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
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
  expect(
    await fixture.rig.host.create(CALLER, params, { hostLaunchDirectory: fixture.rig.root })
  ).toMatchObject({
    ok: true
  })
  expect(fixture.rig.store.getRecord(SESSION)?.launchDirectory).toBe(fixture.rig.root)
  expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
})

it.each(['adopted', 'blank'] as const)(
  'retries a rolled-back create with only the new %s history',
  async (nextSource) => {
    const first = { clientMessageId: hostTestOperationId(), body: hostTestMessage('first attempt') }
    const adopted = await adoptedParams('old imported history')
    const db = openTestJournalHostDatabase(fixture.rig.root).db
    db.exec(
      `CREATE TRIGGER refuse_first BEFORE INSERT ON journal_outcomes WHEN NEW.field = 'submissions' BEGIN SELECT RAISE(ABORT, 'simulated first write failure'); END`
    )
    expect(
      await fixture.rig.host.create(CALLER, createTestParams(first, adopted), {
        firstMessage: first
      })
    ).toMatchObject({ ok: false })
    expect(fixture.rig.store.getRecord(SESSION)).toBeNull()
    expect(fixture.rig.store.listOperationRows()).toEqual([])
    db.exec('DROP TRIGGER refuse_first')
    const next = { clientMessageId: hostTestOperationId(), body: hostTestMessage('next attempt') }
    const nextParams =
      nextSource === 'adopted'
        ? await adoptedParams('new imported history', '019fd532-7c11-7a90-b6de-4e1a2c3d5f61')
        : createTestParams()
    let stopping: ReturnType<typeof stopCreatedChat> | undefined
    const result = await fixture.rig.host.create(
      CALLER,
      createTestParams(next, {
        ...nextParams,
        envelope: { ...nextParams.envelope, clientOperationId: hostTestOperationId() }
      }),
      {
        firstMessage: next,
        publishTab: async () => {
          stopping = stopCreatedChat(fixture.rig.host)
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
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  }
)
