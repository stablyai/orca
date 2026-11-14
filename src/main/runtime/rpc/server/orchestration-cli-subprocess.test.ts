// Exercise compiled CLI keepalives over pipes; skip until built (the verification gate builds it).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { Store } from '../../../persistence/loading-store/store'
import {
  createSqliteTestStore,
  closeTestStores
} from '../../../persistence/persistence-test-harness'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceReferenceUrl } from '../../../../shared/workspace-attachments/workspace-reference-identity'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { formatOrcaSessionAddress } from '../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import { isOrchestrationRetryRequestId } from '../../../../shared/orchestration/orchestration-retry-request-id'
import {
  CALLER,
  hostTestState,
  hostTestRecoveryCapsuleSettled,
  replaceHostTestState
} from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import {
  hostTestAttachParams,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { abandonStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-abandon.test-fixture'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { closeTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStoreText,
  openTestAgentSessionDatabase,
  withTestAgentSessionDatabase
} from '../../agent-session/records/agent-session-record-store-test-harness'
import { idOf, isRecord, resultOf } from '../orchestration/callers/session.test-fixture'

const CLI_PATH = join(process.cwd(), 'out', 'cli', 'index.js')

const describeIfBuilt = existsSync(CLI_PATH) ? describe : describe.skip

function loadRuntimeModules() {
  return Promise.all([
    import('../../orca-runtime'),
    import('../../orchestration/db/orchestration-db'),
    import('./runtime-rpc')
  ])
}

async function runBuiltCli(
  userDataPath: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // These tests read the full receipt, not the concise agent view.
  const fullArgs = args[0] === 'orchestration' ? [...args, '--full'] : args
  const child = spawn(process.execPath, [CLI_PATH, ...fullArgs], {
    env: {
      ...process.env,
      ORCA_USER_DATA_PATH: userDataPath,
      ORCA_TERMINAL_HANDLE: 'term_cli',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => stdoutChunks.push(d))
  child.stderr.on('data', (d) => stderrChunks.push(d))

  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    child.once('exit', (code) => resolveExit(code ?? 1))
    child.once('error', rejectExit)
  })

  return {
    exitCode,
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join('')
  }
}

describeIfBuilt('orca orchestration check --wait subprocess (§3.4)', () => {})

describeIfBuilt('orca orchestration reset subprocess', () => {})

describeIfBuilt('orca orchestration task readiness subprocess', () => {
  it('creates a late dependent as ready through the built CLI and runtime', async () => {
    const [{ OrcaRuntimeService }, { OrchestrationDb }, { OrcaRuntimeRpcServer }] =
      await loadRuntimeModules()
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-cli-task-readiness-'))
    const dbPath = join(userDataPath, 'orchestration.db')
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(dbPath)
    runtime.setOrchestrationDb(db)
    const coordinatorPaneKey = 'tab_cli:22222222-2222-4222-8222-222222222222'
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_cli' ? coordinatorPaneKey : null
    )
    db.createRun({
      objective: 'CLI late dependency readiness fixture',
      coordinatorHandle: 'term_cli',
      coordinatorPaneKey
    })
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    await server.start()

    try {
      const dependencyCreate = await runBuiltCli(userDataPath, [
        'orchestration',
        'task-create',
        '--spec',
        'dependency',
        '--from',
        'term_cli',
        '--json'
      ])
      expect(dependencyCreate.exitCode, dependencyCreate.stderr).toBe(0)
      const dependencyPayload = JSON.parse(dependencyCreate.stdout) as {
        result: { task: { id: string; status: string } }
      }
      const dependencyId = dependencyPayload.result.task.id

      const dependencyComplete = await runBuiltCli(userDataPath, [
        'orchestration',
        'task-update',
        '--id',
        dependencyId,
        '--status',
        'completed',
        '--from',
        'term_cli',
        '--json'
      ])
      expect(dependencyComplete.exitCode, dependencyComplete.stderr).toBe(0)

      const childCreate = await runBuiltCli(userDataPath, [
        'orchestration',
        'task-create',
        '--spec',
        'late dependent',
        '--deps',
        JSON.stringify([dependencyId]),
        '--from',
        'term_cli',
        '--json'
      ])
      expect(childCreate.exitCode, childCreate.stderr).toBe(0)
      const childPayload = JSON.parse(childCreate.stdout) as {
        result: { task: { id: string; status: string } }
      }
      const child = childPayload.result.task
      expect(child.status).toBe('ready')

      const taskList = await runBuiltCli(userDataPath, [
        'orchestration',
        'task-list',
        '--from',
        'term_cli',
        '--json'
      ])
      expect(taskList.exitCode, taskList.stderr).toBe(0)
      const taskListPayload = JSON.parse(taskList.stdout) as {
        result: { tasks: { id: string; status: string }[] }
      }
      expect(taskListPayload.result.tasks).toContainEqual(
        expect.objectContaining({ id: child.id, status: 'ready' })
      )

      const persisted = new OrchestrationDb(dbPath)
      try {
        expect(persisted.getTask(child.id)?.status).toBe('ready')
      } finally {
        persisted.close()
      }
    } finally {
      db.close()
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  }, 30_000)
})

describeIfBuilt('native caller subprocess over durable records', () => {
  // Real CLI subprocess round trips include store reopen, retry/refusal checks and IPC cleanup.
  it('saves and replays the native caller result, then separates damaged admission from reference reads', async () => {
    const [{ OrcaRuntimeService }, { OrchestrationDb }, { OrcaRuntimeRpcServer }] =
      await loadRuntimeModules()
    const rig = hostTestState()
    const sessionId = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
    const invalidId = testOrcaSessionId('7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64')
    const absentId = testOrcaSessionId('11111111-2222-4333-8444-555555555555')
    const repoPath = join(rig.root, 'workspace')
    const workspaceId = `cli_repo::${repoPath}`
    const profile = createSqliteTestStore(Store, { dataFile: join(rig.root, 'cli-data.json') })
    profile.addRepo({
      id: 'cli_repo',
      path: repoPath,
      displayName: 'CLI fixture',
      badgeColor: 'gray',
      addedAt: 1
    })
    profile.setWorktreeMeta(hostWorktreeTarget({ id: workspaceId, hostId: 'local' }), {
      displayName: 'CLI fixture',
      linkedItems: [
        {
          ...parseWorkspaceReferenceUrl('https://linear.app/acme/issue/STA-1234'),
          origins: [
            {
              kind: 'observed',
              hostId: 'local',
              agent: 'codex',
              sessionId,
              tabId: structuredAgentSessionTabId(sessionId)
            }
          ]
        }
      ]
    })
    const runtime = new OrcaRuntimeService(profile)
    const db = new OrchestrationDb(join(rig.root, 'orchestration.db'))
    runtime.setOrchestrationDb(db)
    let host = rig.host
    let store = rig.store
    setStructuredAgentSessionHost(host)
    // Install the complete test host; all admission, SQLite, RPC and reference logic stays real.
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
    vi.spyOn(runtime, 'openAgentSessionRecordStore').mockImplementation(async () => store)
    const terminalLookup = vi.spyOn(runtime, 'getTerminalPaneKey')
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath: rig.root })
    const nativeEnv = {
      ORCA_AGENT_SESSION_ID: sessionId,
      ORCA_TERMINAL_HANDLE: 'term_stale_cli',
      ORCA_PANE_KEY: 'tab_stale:11111111-1111-4111-8111-111111111111',
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: ''
    }
    const command = [
      'orchestration',
      'run-create',
      '--objective',
      'native CLI saved result',
      '--json'
    ]
    const state = () => ({
      runs: db.db.prepare('SELECT * FROM runs ORDER BY id').all(),
      mail: db.db.prepare('SELECT * FROM messages ORDER BY id').all(),
      receipts: db.db
        .prepare('SELECT * FROM mutation_receipts ORDER BY caller_fingerprint, request_id')
        .all(),
      dispatches: db.db.prepare('SELECT * FROM dispatch_contexts ORDER BY id').all()
    })
    try {
      const params = hostTestAttachParams(null, {
        envelope: {
          sessionId,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: '0'.repeat(64)
        },
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId,
          workspaceKind: 'git-worktree'
        }
      })
      expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
      await store.setSessionTabVisibility(sessionId, true)
      expect(store.getRecord(sessionId)?.lease).toMatchObject({
        claimStatus: 'live',
        unreconciled: false,
        handoffStage: null
      })
      await server.start()
      const created = await runBuiltCli(rig.root, command, nativeEnv)
      expect(created.exitCode, created.stderr).toBe(0)
      const result = resultOf(JSON.parse(created.stdout))
      const runId = idOf(result.run)
      if (!isRecord(result.mutation) || typeof result.mutation.requestId !== 'string') {
        throw new Error(`Missing actual mutation request ID: ${created.stdout}`)
      }
      const requestId = result.mutation.requestId
      expect(result.mutation).toMatchObject({ replayed: false })
      expect(db.getRun(runId)).toMatchObject({
        objective: 'native CLI saved result',
        coordinator_orca_session_id: sessionId,
        coordinator_handle: null,
        coordinator_pane_key: null
      })
      expect(
        terminalLookup.mock.calls.every(
          ([handle]) => handle === formatOrcaSessionAddress(sessionId)
        )
      ).toBe(true)
      expect(
        terminalLookup.mock.results.every(
          (result) => result.type === 'return' && result.value === null
        )
      ).toBe(true)
      const saved = state()
      expect(saved.receipts).toHaveLength(1)
      expect(saved.receipts[0]).toMatchObject({
        request_id: requestId,
        method: 'orchestration.runCreate',
        state: 'completed'
      })
      const retry = await runBuiltCli(
        rig.root,
        [...command, '--retry-request', requestId],
        nativeEnv
      )
      expect(retry.exitCode, retry.stderr).toBe(0)
      expect(resultOf(JSON.parse(retry.stdout))).toMatchObject({
        run: { id: runId },
        mutation: { requestId, replayed: true }
      })
      expect(state()).toEqual(saved)
      const wrong = await runBuiltCli(
        rig.root,
        [...command, '--from', formatOrcaSessionAddress(invalidId)],
        nativeEnv
      )
      expect(wrong.exitCode).toBe(1)
      expect(JSON.parse(wrong.stdout)).toMatchObject({
        ok: false,
        error: { code: 'consumer_fenced', data: { effectsApplied: false } }
      })
      expect(state()).toEqual(saved)

      await abandonStructuredAgentSessionHost(host)
      await hostTestRecoveryCapsuleSettled()
      await withTestAgentSessionDatabase(rig.root, (nativeDb) => {
        const before = nativeDb
          .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
          .get(sessionId)
        expect(before).toBeDefined()
        nativeDb
          .prepare(`
        UPDATE agent_session_records
        SET record_json = json_set(record_json, '$.lease.minimumNextFence', 'bad')
        WHERE session_id = ?
      `)
          .run(sessionId)
        const damaged = nativeDb
          .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
          .get(sessionId)
        if (typeof before?.record_json !== 'string' || typeof damaged?.record_json !== 'string') {
          throw new Error('Expected persisted native record JSON')
        }
        const original: unknown = JSON.parse(before.record_json)
        if (!isRecord(original) || !isRecord(original.lease)) {
          throw new Error('Expected checked original record and lease')
        }
        expect(JSON.parse(damaged.record_json)).toEqual({
          ...original,
          lease: { ...original.lease, minimumNextFence: 'bad' }
        })
        // A second visible raw row must be excluded because its conversation cannot be checked.
        nativeDb
          .prepare(`
        INSERT INTO agent_session_records (session_id, record_json)
        SELECT ?, json_set(record_json, '$.sessionId', ?, '$.lease.sessionId', ?,
          '$.providerHandleChain', 'bad')
        FROM agent_session_records WHERE session_id = ?
      `)
          .run(invalidId, invalidId, invalidId, sessionId)
        nativeDb
          .prepare(`
        INSERT INTO agent_session_tabs (tab_id, session_id, position) VALUES (?, ?, 1)
      `)
          .run(structuredAgentSessionTabId(invalidId), invalidId)
      })
      await closeTestJournalHostDatabase(rig.root)
      store = await openTestAgentSessionRecordStore(rig.root)
      host = new StructuredAgentSessionHost({
        ...rig.host.deps,
        store,
        journalDatabase: await openTestAgentSessionDatabase(rig.root)
      })
      replaceHostTestState({ host, store })
      setStructuredAgentSessionHost(host)
      expect(store.getConversation(sessionId)?.sessionId).toBe(sessionId)
      expect(store.getRecord(sessionId)).toBeNull()
      expect(store.getConversation(invalidId)).toBeNull()
      expect(store.getVisibleSessionTabIndex().sessionIds).toEqual([sessionId])
      const raw = await readPersistedTestAgentSessionStoreText(rig.root)
      const acquisitions = rig.acquire.mock.calls.length
      const dispatches = rig.dispatch.mock.calls.length
      const refused = await runBuiltCli(
        rig.root,
        ['orchestration', 'run-create', '--objective', 'fresh damaged caller', '--json'],
        nativeEnv
      )
      expect(refused.exitCode).toBe(1)
      const refusedPayload: unknown = JSON.parse(refused.stdout)
      if (
        !isRecord(refusedPayload) ||
        !isRecord(refusedPayload.error) ||
        !isRecord(refusedPayload.error.data) ||
        !isOrchestrationRetryRequestId(refusedPayload.error.data.orchestrationRequestId)
      ) {
        throw new Error('Expected fresh mutation refusal with a valid request ID')
      }
      const failedRequestId = refusedPayload.error.data.orchestrationRequestId
      expect(refusedPayload).toMatchObject({
        ok: false,
        error: {
          code: 'execution_owner_reconciling',
          message: `execution_owner_reconciling Orchestration mutation request ID: ${failedRequestId}.`,
          data: {
            orchestrationRequestId: failedRequestId,
            refusal: {
              code: 'execution_owner_reconciling',
              details: { reason: 'recordUnreadable' }
            }
          }
        }
      })
      // Caller admission precedes receipt replay even when the old mutation was completed.
      const damagedRetry = await runBuiltCli(
        rig.root,
        [...command, '--retry-request', requestId],
        nativeEnv
      )
      expect(damagedRetry.exitCode).toBe(1)
      const damagedRetryPayload: unknown = JSON.parse(damagedRetry.stdout)
      if (
        !isRecord(damagedRetryPayload) ||
        !isRecord(damagedRetryPayload.error) ||
        !isRecord(damagedRetryPayload.error.data) ||
        !isOrchestrationRetryRequestId(damagedRetryPayload.error.data.orchestrationRequestId)
      ) {
        throw new Error('Expected retry mutation refusal with a valid request ID')
      }
      expect(damagedRetryPayload.error.data.orchestrationRequestId).toBe(requestId)
      expect(damagedRetryPayload).toMatchObject({
        ok: false,
        error: {
          code: 'execution_owner_reconciling',
          message: `execution_owner_reconciling Orchestration mutation request ID: ${requestId}.`,
          data: {
            orchestrationRequestId: requestId,
            refusal: {
              code: 'execution_owner_reconciling',
              details: { reason: 'recordUnreadable' }
            }
          }
        }
      })
      const absent = await runBuiltCli(rig.root, command, {
        ...nativeEnv,
        ORCA_AGENT_SESSION_ID: absentId
      })
      expect(absent.exitCode).toBe(1)
      expect(JSON.parse(absent.stdout)).toMatchObject({
        ok: false,
        error: { code: 'session_caller_unknown', data: { effectsApplied: false } }
      })
      const found = await runBuiltCli(
        rig.root,
        ['reference', 'find', '--query', 'STA-1234', '--json'],
        { ...nativeEnv, ORCA_AGENT_SESSION_ID: '', ORCA_TERMINAL_HANDLE: '', ORCA_PANE_KEY: '' }
      )
      expect(found.exitCode, found.stderr).toBe(0)
      const references = resultOf(JSON.parse(found.stdout))
      expect(references).toMatchObject({ kind: 'reference_matches', truncated: false })
      if (!Array.isArray(references.matches) || references.matches.length !== 1) {
        throw new Error(`Expected the saved issue workspace: ${found.stdout}`)
      }
      expect(references.matches[0]).toMatchObject({
        workspace: { id: workspaceId },
        agents: [
          {
            sessionId,
            agent: 'codex',
            liveness: 'unverifiable',
            linked: true,
            mailbox: formatOrcaSessionAddress(sessionId)
          }
        ]
      })
      expect(state()).toEqual(saved)
      expect(await readPersistedTestAgentSessionStoreText(rig.root)).toBe(raw)
      expect(rig.acquire).toHaveBeenCalledTimes(acquisitions)
      expect(rig.dispatch).toHaveBeenCalledTimes(dispatches)
      expect(
        terminalLookup.mock.calls.every(
          ([handle]) => handle === formatOrcaSessionAddress(sessionId)
        )
      ).toBe(true)
      expect(
        terminalLookup.mock.results.every(
          (result) => result.type === 'return' && result.value === null
        )
      ).toBe(true)
    } finally {
      await server.stop()
      await abandonStructuredAgentSessionHost(host)
      await hostTestRecoveryCapsuleSettled()
      setStructuredAgentSessionHost(null)
      await closeTestStores()
      db.close()
      vi.restoreAllMocks()
    }
  }, 60_000)
})
