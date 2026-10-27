// Exercise compiled CLI keepalives over pipes; skip until built (the verification gate builds it).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { Store } from '../persistence/loading-store/store'
import { createSqliteTestStore, closeTestStores } from '../persistence/persistence-test-harness'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import { parseWorkspaceReferenceUrl } from '../../shared/workspace-reference-identity'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { isOrchestrationRetryRequestId } from '../../shared/orchestration-retry-request-id'
import {
  CALLER,
  hostTestState,
  hostTestRecoveryCapsuleSettled,
  replaceHostTestState
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  hostTestAttachParams,
  hostTestOperationId
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { abandonStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host-test-abandon'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStoreText
} from './agent-session-record-store-test-harness'
import { idOf, isRecord, resultOf } from './rpc/orchestration-session-caller-test-fixture'

const CLI_PATH = join(process.cwd(), 'out', 'cli', 'index.js')

const describeIfBuilt = existsSync(CLI_PATH) ? describe : describe.skip

function loadRuntimeModules() {
  return Promise.all([
    import('./orca-runtime'),
    import('./orchestration/db'),
    import('./runtime-rpc')
  ])
}

async function runBuiltCli(
  userDataPath: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
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

describeIfBuilt('orca orchestration check --wait subprocess (§3.4)', () => {
  it('emits newline-flushed JSON keepalives to stderr while waiting', async () => {
    const [{ OrcaRuntimeService }, { OrchestrationDb }, { OrcaRuntimeRpcServer }] =
      await loadRuntimeModules()
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-cli-sub-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    // A consuming inbox check requires a live pane, even when no messages exist.
    const paneKey = 'tab_keepalive:11111111-1111-4111-8111-111111111111'
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_nobody' ? paneKey : null
    )
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      runtime.getTerminalPaneKey(handle)
    )
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    await server.start()

    try {
      // Shorten the keepalive interval to keep the subprocess test near one second.
      const keepaliveMs = 200
      const waitTimeoutMs = 1200

      const child = spawn(
        process.execPath,
        [
          CLI_PATH,
          'orchestration',
          'check',
          '--wait',
          '--timeout-ms',
          String(waitTimeoutMs),
          '--json'
        ],
        {
          env: {
            ...process.env,
            ORCA_USER_DATA_PATH: userDataPath,
            ORCA_TERMINAL_HANDLE: 'term_nobody',
            ORCA_KEEPALIVE_INTERVAL_MS: String(keepaliveMs)
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )

      const stderrChunks: { at: number; data: string }[] = []
      const stdoutChunks: { at: number; data: string }[] = []
      const startedAt = Date.now()
      child.stderr.setEncoding('utf8')
      child.stdout.setEncoding('utf8')
      child.stderr.on('data', (d) => stderrChunks.push({ at: Date.now() - startedAt, data: d }))
      child.stdout.on('data', (d) => stdoutChunks.push({ at: Date.now() - startedAt, data: d }))

      const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
        child.once('exit', (code) => resolveExit(code ?? 1))
        child.once('error', rejectExit)
      })

      const stderr = stderrChunks.map((c) => c.data).join('')
      const stdout = stdoutChunks.map((c) => c.data).join('')
      expect(exitCode, stderr).toBe(0)

      const keepaliveLines = stderr
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>
          } catch {
            return null
          }
        })
        .filter((p): p is Record<string, unknown> => p !== null && p._keepalive === true)

      expect(keepaliveLines.length).toBeGreaterThanOrEqual(3)
      expect(keepaliveLines[0]).toMatchObject({ _keepalive: true, _heartbeat: true })
      expect(keepaliveLines[0]).toHaveProperty('elapsedMs')
      expect(keepaliveLines[0]).toHaveProperty('deadlineMs', waitTimeoutMs)

      // Under load, startup can exceed one interval; require a keepalive before terminal stdout.
      const firstKeepaliveChunk = stderrChunks.find((c) => c.data.includes('_keepalive'))
      expect(firstKeepaliveChunk).toBeDefined()
      expect(firstKeepaliveChunk!.at).toBeLessThan(stdoutChunks[0]?.at ?? Number.POSITIVE_INFINITY)

      // Separate stderr events before exit prove line flushing rather than exit-time buffering.
      const lastStderrAt = stderrChunks.at(-1)?.at ?? 0
      const firstStderrAt = stderrChunks.at(0)?.at ?? 0
      expect(lastStderrAt).toBeGreaterThan(firstStderrAt)

      const stdoutTrimmed = stdout.trim()
      const stdoutPayload = JSON.parse(stdoutTrimmed) as Record<string, unknown>
      expect(stdoutPayload).not.toHaveProperty('_keepalive')
      expect(stdoutTrimmed).not.toContain('_keepalive')
      expect(stdoutPayload).toMatchObject({ ok: true })

      // Each stderr keepalive must be one JSON line for merged-stream jq filtering.
      for (const line of stderr.split('\n')) {
        if (line.trim().length === 0) {
          continue
        }
        if (line.includes('_keepalive')) {
          expect(() => JSON.parse(line)).not.toThrow()
          expect(line).not.toContain('\n')
        }
      }
    } finally {
      db.close()
      await server.stop()
      vi.restoreAllMocks()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  }, 30_000)
})

describeIfBuilt('orca orchestration reset subprocess', () => {
  it('validates reset scopes against an isolated runtime through the built CLI', async () => {
    const [{ OrcaRuntimeService }, { OrchestrationDb }, { OrcaRuntimeRpcServer }] =
      await loadRuntimeModules()
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-cli-reset-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const coordinatorPaneKey = 'tab_cli:11111111-1111-4111-8111-111111111111'
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_cli'
        ? coordinatorPaneKey
        : handle === 'term_target'
          ? 'tab_target:33333333-3333-4333-8333-333333333333'
          : null
    )
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      runtime.getTerminalPaneKey(handle)
    )
    db.createRun({
      objective: 'CLI reset subprocess fixture',
      coordinatorHandle: 'term_cli',
      coordinatorPaneKey
    })
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    await server.start()

    try {
      const send = await runBuiltCli(userDataPath, [
        'orchestration',
        'send',
        '--to',
        'term_target',
        '--subject',
        'hello',
        '--json'
      ])
      expect(send.exitCode, send.stderr).toBe(0)

      const create = await runBuiltCli(userDataPath, [
        'orchestration',
        'task-create',
        '--spec',
        'throwaway task',
        '--from',
        'term_cli',
        '--json'
      ])
      expect(create.exitCode, create.stderr).toBe(0)
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(1)

      const invalid = await runBuiltCli(userDataPath, [
        'orchestration',
        'reset',
        '--tasks',
        '--messages',
        '--json'
      ])
      expect(invalid.exitCode).toBe(1)
      const invalidPayload = JSON.parse(invalid.stdout) as {
        ok: boolean
        error: { code: string; message: string }
      }
      expect(invalidPayload.ok).toBe(false)
      expect(invalidPayload.error.code).toBe('invalid_argument')
      expect(invalidPayload.error.message).toContain('Choose exactly one reset scope')
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(1)

      const resetTasks = await runBuiltCli(userDataPath, [
        'orchestration',
        'reset',
        '--tasks',
        '--json'
      ])
      expect(resetTasks.exitCode, resetTasks.stderr).toBe(0)
      expect(JSON.parse(resetTasks.stdout)).toMatchObject({ ok: true, result: { reset: 'tasks' } })
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(0)

      // Reset removes Runs; recreate the caller binding before creating another task.
      db.createRun({
        objective: 'CLI reset subprocess fixture after reset',
        coordinatorHandle: 'term_cli',
        coordinatorPaneKey
      })
      const recreate = await runBuiltCli(userDataPath, [
        'orchestration',
        'task-create',
        '--spec',
        'throwaway task after partial reset',
        '--from',
        'term_cli',
        '--json'
      ])
      expect(recreate.exitCode, recreate.stderr).toBe(0)
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(1)

      const bareReset = await runBuiltCli(userDataPath, ['orchestration', 'reset', '--json'])
      expect(bareReset.exitCode).toBe(1)
      expect(JSON.parse(bareReset.stdout)).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(1)

      const resetAll = await runBuiltCli(userDataPath, [
        'orchestration',
        'reset',
        '--all',
        '--json'
      ])
      expect(resetAll.exitCode, resetAll.stderr).toBe(0)
      expect(JSON.parse(resetAll.stdout)).toMatchObject({ ok: true, result: { reset: 'all' } })
      expect(db.getInbox()).toHaveLength(0)
      expect(db.listTasks()).toHaveLength(0)
    } finally {
      db.close()
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  }, 30_000)
})

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
      const nativeDb = openTestJournalHostDatabase(rig.root).db
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
      closeTestJournalHostDatabase(rig.root)
      store = await openTestAgentSessionRecordStore(rig.root)
      host = new StructuredAgentSessionHost({
        ...rig.host.deps,
        store,
        journalDatabase: openTestJournalHostDatabase(rig.root)
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
