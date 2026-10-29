import { writeFile, rm, mkdir, realpath, symlink, readFile } from 'node:fs/promises'
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
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import { adoptedDirectoryProbes } from '../agent-session-journal/adopted-directory-probe'
import { writeOpenCodeSqliteDatabase } from '../../ai-vault/session-scanner-opencode-sqlite-fixture'
import { structuredAgentRuntimeRegistration } from '../../runtime/structured-agent-runtime-registrations'
import { structuredAgentsDeclaringNothing } from './structured-agent-session-adapter-router-test-support'
import { resolveAgentSessionLaunchDirectory } from '../../runtime/agent-session-launch-directory'
import { createClaudeStructuredLaunchResolver } from '../../runtime/structured-agent-launch-composition.test-support'

vi.mock('../../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async (original) => {
  const query = await import('../transcript-opencode-sqlite-query')
  return {
    ...(await original<object>()),
    readOpenCodeTranscriptPageViaWorker: query.readOpenCodeTranscriptPage,
    readOpenCodeTranscriptSignalViaWorker: async (args: { dbPath: string; sessionId: string }) =>
      query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId)
  }
})

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
    adopt: { providerHandle: codexProviderHandle(threadId), transcriptPath }
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

it.each([100, 1000])(
  'imports %s source rows into a linked workspace with one fresh probe and zero replay work',
  async (size) => {
    const physical = await realpath(rig.root)
    const registered = join(rig.root, 'registered')
    await symlink(physical, registered, process.platform === 'win32' ? 'junction' : 'dir')
    const transcriptPath = join(rig.root, `${THREAD}.jsonl`)
    // Captured CLI transcript metadata; relocate fixture identity/cwd into the isolated host.
    const captured = (
      await readFile(
        join(__dirname, '..', '__fixtures__', 'openclaude-0.31.0-local-command-rows.jsonl'),
        'utf8'
      )
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((row) => row.type === 'user' && !row.isMeta)
    expect(captured.cwd).toBe('/tmp/project')
    await writeFile(
      transcriptPath,
      `${Array.from({ length: size }, (_, index) =>
        JSON.stringify({
          ...captured,
          uuid: `original-${index}`,
          sessionId: THREAD,
          cwd: physical,
          message: { role: 'user', content: 'original physical-keyed context' }
        })
      ).join('\n')}\n`
    )
    const params = createTestParams(undefined, {
      agent: 'claude',
      provider: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: rig.root },
      adopt: {
        providerHandle: claudeProviderHandle(THREAD, null),
        transcriptPath,
        source: { providerSessionId: THREAD, workspaceCwd: registered }
      }
    })
    const probe = vi.spyOn(adoptedDirectoryProbes, 'matches')
    const publishTab = vi.fn(async () => {
      expect(rig.store.getRecord(SESSION)?.providerHandleChain[0].handle.nativeId).toBe(THREAD)
    })
    const result = await rig.host.create(CALLER, params, { publishTab })
    expect(result).toMatchObject({
      ok: true,
      value: {
        page: {
          items: expect.arrayContaining([
            expect.objectContaining({
              body: expect.objectContaining({
                blocks: [{ type: 'text', text: 'original physical-keyed context' }]
              })
            })
          ])
        }
      }
    })
    expect(publishTab).toHaveBeenCalledOnce()
    expect(rig.store.getRecord(SESSION)?.accountHome).toEqual(params.accountHome)
    expect(params.adopt?.source?.workspaceCwd).toBe(registered)
    const record = rig.store.getRecord(SESSION)!
    expect(
      await resolveAgentSessionLaunchDirectory(
        { store: rig.store, resolveWorkspacePath: async () => registered },
        record
      )
    ).toBe(registered)
    expect(record.providerHandleChain[0].handle.nativeId).toBe(THREAD)
    const hasTranscript = vi.fn(
      async ({
        providerSessionId,
        claudeConfigDir
      }: {
        providerSessionId: string
        claudeConfigDir: string
      }) =>
        providerSessionId === THREAD &&
        claudeConfigDir === rig.root &&
        (await readFile(transcriptPath, 'utf8')).includes(THREAD)
    )
    const launch = await createClaudeStructuredLaunchResolver({
      store: rig.store,
      resolveWorkspacePath: async () => registered,
      resolveCommand: () => ({ command: process.execPath, prefixArgs: [] }),
      resolveInheritedEnv: async () => ({}),
      resolveAuthPolicy: () => ({ account: 'system' }),
      resolveLaunchArgs: () => [],
      hasTranscript
    })({
      identity: {
        sessionId: SESSION,
        workspaceId: record.location.workspaceId,
        hostId: 'local',
        agent: 'claude',
        providerHandle: record.providerHandleChain[0].handle
      }
    })
    expect(launch).toMatchObject({
      cwd: registered,
      providerSessionId: THREAD,
      claudeConfigDir: rig.root,
      options: { resume: THREAD }
    })
    expect(hasTranscript).toHaveBeenCalledWith({
      providerSessionId: THREAD,
      claudeConfigDir: rig.root
    })
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    expect(probe).toHaveBeenCalledOnce()
    await rig.host.flushAllStreamedEvents()
    await rig.restart()
    await rm(transcriptPath)
    expect(await rig.host.create(CALLER, params)).toMatchObject({ ok: true, replayed: true })
    expect(probe).toHaveBeenCalledOnce()
  }
)

it('uses current selected ancestors, then refuses retargeted/foreign sources before ownership', async () => {
  const physical = join(await realpath(rig.root), 'physical')
  const moved = join(await realpath(rig.root), 'moved')
  const registered = join(rig.root, 'registered')
  await mkdir(physical)
  await mkdir(moved)
  await symlink(physical, registered, process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(moved, join(physical, 'pkg'), process.platform === 'win32' ? 'junction' : 'dir')
  const sourceCwd = join(physical, 'pkg')
  const workspaceCwd = join(registered, 'pkg')
  expect(await realpath(workspaceCwd)).toBe(moved)
  const transcriptPath = join(rig.root, `${THREAD}.jsonl`)
  const save = async (sessionId: string, cwd: string) =>
    writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'original',
        sessionId,
        cwd,
        message: { role: 'user', content: 'ancestor context' }
      })}\n`
    )
  const params = createTestParams(undefined, {
    agent: 'claude',
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: rig.root },
    adopt: {
      providerHandle: claudeProviderHandle(THREAD, null),
      transcriptPath,
      source: { providerSessionId: THREAD, workspaceCwd }
    }
  })
  const probe = vi.spyOn(adoptedDirectoryProbes, 'matches')
  await save('wrong-provider', sourceCwd)
  expect(await rig.host.create(CALLER, params)).toMatchObject({ ok: false })
  expect(probe).not.toHaveBeenCalled()
  await save(THREAD, join(rig.root, 'foreign'))
  expect(await rig.host.create(CALLER, params)).toMatchObject({ ok: false })
  expect(rig.store.listRecords()).toEqual([])
  await save(THREAD, sourceCwd)
  await rm(registered)
  await symlink(moved, registered, process.platform === 'win32' ? 'junction' : 'dir')
  expect(await rig.host.create(CALLER, params)).toMatchObject({ ok: false })
  expect(rig.store.listRecords()).toEqual([])
  await rm(registered)
  await symlink(physical, registered, process.platform === 'win32' ? 'junction' : 'dir')
  expect(await rig.host.create(CALLER, params)).toMatchObject({ ok: true })
  expect(probe).toHaveBeenLastCalledWith(workspaceCwd, sourceCwd, expect.any(AbortSignal))
  expect(await rig.host.create(CALLER, params)).toMatchObject({ ok: true, replayed: true })
})

it.each(['opencode', 'opencode2'] as const)(
  'commits %s actual database history using the same linked-cwd admission',
  async (agent) => {
    const definition = structuredAgentRuntimeRegistration(agent)!.definition
    await rig.dispose()
    rig = await createRestTestRig({ agents: structuredAgentsDeclaringNothing([definition]) })
    const physical = await realpath(rig.root)
    const registered = join(rig.root, 'registered')
    await symlink(physical, registered, process.platform === 'win32' ? 'junction' : 'dir')
    const transcriptPath = join(rig.root, 'opencode.db')
    writeOpenCodeSqliteDatabase(transcriptPath, [
      { id: THREAD, directory: physical, turns: [{ role: 'user', parts: ['database context'] }] }
    ])
    const params = createTestParams(undefined, {
      agent,
      provider: agent,
      accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } },
      adopt: {
        providerHandle: { agent, transport: definition.handleTransport, nativeId: THREAD },
        transcriptPath,
        source: { providerSessionId: THREAD, workspaceCwd: registered }
      }
    })
    expect(await rig.host.create(CALLER, params)).toMatchObject({ ok: true })
    expect(rig.store.getRecord(SESSION)?.providerHandleChain[0].handle.nativeId).toBe(THREAD)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  }
)

it('imports adoption at rest and resumes its original provider identity after its source disappears', async () => {
  const params = await adoptedParams()
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
  await rm(join(rig.root, 'rollout.jsonl'))
  expect(
    await rig.host.create(CALLER, {
      ...params,
      accountHome: { variable: 'CODEX_HOME', path: '/drifted/account' },
      adopt: { providerHandle: codexProviderHandle(THREAD) }
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

it.each(['missing', 'empty', 'malformed'] as const)(
  'refuses %s history before founding anything',
  async (source) => {
    const params = await adoptedParams()
    await (source === 'missing'
      ? rm(join(rig.root, 'rollout.jsonl'))
      : writeFile(join(rig.root, 'rollout.jsonl'), source === 'empty' ? '' : '{broken json}\n'))
    expect(await rig.host.create(CALLER, params)).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_identity_required',
        details: { reason: source === 'empty' ? 'transcriptNotFound' : 'transcriptUnreadable' },
        createAttemptRefusedBeforeCommit: true
      }
    })
    expect(rig.store.listRecords()).toEqual([])
    expect(rig.store.listOperationRows()).toEqual([])
  }
)

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
