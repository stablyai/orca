import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/host/app'
  }
}))
vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: () => '/host/user-data'
}))

import { OrchestrationDb } from '../runtime/orchestration/db'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type Database from '../sqlite/sync-database'
import type { HostCliPassthroughOptions } from './ssh-remote-cli-host-passthrough'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'
import { acknowledgeRemoteOrcaCliPostOutput } from './ssh-remote-orchestration-post-output'
import { createRootDispatch } from '../runtime/orchestration/db/root-dispatch-test-fixture'

const LEGACY_FALLBACK_OPTIONS: HostCliPassthroughOptions = {
  execPath: '/host/electron',
  cliEntryPath: '/host/app/out/cli/index.js',
  userDataPath: '/host/user-data',
  entryExists: () => false
}
const WORKER_HANDLE = 'term_legacy_ssh_worker'
const WORKER_PANE = 'tab_legacy_ssh:33333333-3333-4333-8333-333333333333'
const COORDINATOR_HANDLE = 'term_legacy_ssh_coord'
const COORDINATOR_PANE = 'tab_legacy_coord:44444444-4444-4444-8444-444444444444'
const WORKER_ENV = {
  ORCA_TERMINAL_HANDLE: WORKER_HANDLE,
  ORCA_PANE_KEY: WORKER_PANE,
  ORCA_AGENT_LAUNCH_TOKEN: 'legacy-ssh-token'
}
const COORDINATOR_ENV = {
  ORCA_TERMINAL_HANDLE: COORDINATOR_HANDLE,
  ORCA_PANE_KEY: COORDINATOR_PANE,
  ORCA_AGENT_LAUNCH_TOKEN: 'legacy-ssh-coordinator-token'
}
const RUNTIME_AUTHORITY = {
  kind: 'ssh' as const,
  targetId: 'saved-target',
  connectionIncarnation: 'connection-1',
  attachmentId: 'attachment-1'
}

function createLegacyRuntime() {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'Adopted legacy SSH work',
    coordinatorHandle: COORDINATOR_HANDLE,
    coordinatorPaneKey: COORDINATOR_PANE
  })
  const task = db.createTask({
    spec: 'legacy SSH assignment',
    runId: run.id,
    createdByTerminalHandle: COORDINATOR_HANDLE
  })
  const dispatch = createRootDispatch(db, task.id, WORKER_HANDLE, WORKER_PANE)
  const sqlite = (db as unknown as { db: Database.Database }).db
  sqlite
    .prepare(
      `UPDATE dispatch_contexts
       SET contract_version = 0, process_incarnation = 'process-1'
       WHERE id = ?`
    )
    .run(dispatch.id)
  sqlite
    .prepare(
      `INSERT INTO legacy_adoptions (source_run_id, adopted_run_id, scheduler_state_lost)
       VALUES ('run_legacy_local', ?, 1)`
    )
    .run(run.id)
  sqlite
    .prepare(
      `UPDATE runs
       SET coordinator_handle = NULL, coordinator_pane_key = NULL, consumer_generation = 0
       WHERE id = ?`
    )
    .run(run.id)

  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === WORKER_HANDLE ? WORKER_PANE : handle === COORDINATOR_HANDLE ? COORDINATOR_PANE : null
  )
  vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
    const worker =
      evidence?.terminalHandle === WORKER_HANDLE &&
      evidence.paneKey === WORKER_PANE &&
      evidence.launchToken === WORKER_ENV.ORCA_AGENT_LAUNCH_TOKEN
    const coordinator =
      evidence?.terminalHandle === COORDINATOR_HANDLE &&
      evidence.paneKey === COORDINATOR_PANE &&
      evidence.launchToken === COORDINATOR_ENV.ORCA_AGENT_LAUNCH_TOKEN
    if (
      (!worker && !coordinator) ||
      evidence.host?.kind !== 'ssh' ||
      evidence.host.targetId !== RUNTIME_AUTHORITY.targetId ||
      evidence.host.connectionIncarnation !== RUNTIME_AUTHORITY.connectionIncarnation
    ) {
      return null
    }
    const identity = worker
      ? {
          terminalHandle: WORKER_HANDLE,
          paneKey: WORKER_PANE,
          launchToken: WORKER_ENV.ORCA_AGENT_LAUNCH_TOKEN
        }
      : {
          terminalHandle: COORDINATOR_HANDLE,
          paneKey: COORDINATOR_PANE,
          launchToken: COORDINATOR_ENV.ORCA_AGENT_LAUNCH_TOKEN
        }
    return {
      hostScope: { kind: 'ssh', targetId: RUNTIME_AUTHORITY.targetId },
      terminalHandle: identity.terminalHandle,
      paneKey: identity.paneKey,
      processIncarnation: 'process-1',
      launchTokenHash: createHash('sha256').update(identity.launchToken).digest('hex')
    }
  })
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  return { db, runtime, run: db.getRun(run.id)!, dispatch }
}

describe('legacy SSH orchestration fallback', () => {
  it('acknowledges a consuming check only after remote output', async () => {
    const { db, runtime, run } = createLegacyRuntime()
    const message = db.insertMessage({
      runId: run.id,
      deliveryContract: 'legacy_direct',
      from: COORDINATOR_HANDLE,
      to: WORKER_HANDLE,
      subject: 'retained SSH mail'
    })
    const request = {
      argv: ['orchestration', 'check', '--unread', '--inject', '--json'],
      cwd: '/home/alice/repo',
      env: WORKER_ENV,
      runtimeAuthority: RUNTIME_AUTHORITY
    }

    try {
      const first = await runRemoteOrcaCli(runtime, request, LEGACY_FALLBACK_OPTIONS)
      const replay = await runRemoteOrcaCli(runtime, request, LEGACY_FALLBACK_OPTIONS)

      expect(JSON.parse(first.stdout)).toMatchObject({
        result: {
          messages: [{ id: message.id }],
          formatted: expect.stringContaining('retained SSH mail')
        }
      })
      expect(first.postOutput).toEqual({
        kind: 'legacy_check_ack',
        terminal: WORKER_HANDLE,
        messageIds: [message.id]
      })
      expect(JSON.parse(replay.stdout)).toMatchObject({
        result: { messages: [{ id: message.id }] }
      })
      expect(db.getMessageById(message.id)?.read).toBe(0)

      await acknowledgeRemoteOrcaCliPostOutput(runtime, {
        postOutput: first.postOutput!,
        env: WORKER_ENV,
        runtimeAuthority: RUNTIME_AUTHORITY
      })
      const afterAck = await runRemoteOrcaCli(runtime, request, LEGACY_FALLBACK_OPTIONS)

      expect(JSON.parse(afterAck.stdout)).toMatchObject({ result: { messages: [], count: 0 } })
      expect(afterAck.postOutput).toBeUndefined()
      expect(db.getMessageById(message.id)?.read).toBe(1)
    } finally {
      db.close()
    }
  })

  it('keeps peek formatted and non-consuming', async () => {
    const { db, runtime, run } = createLegacyRuntime()
    const message = db.insertMessage({
      runId: run.id,
      deliveryContract: 'legacy_direct',
      from: COORDINATOR_HANDLE,
      to: WORKER_HANDLE,
      subject: 'inspect retained SSH mail'
    })

    try {
      const peek = await runRemoteOrcaCli(
        runtime,
        {
          argv: ['orchestration', 'check', '--peek', '--format', '--json'],
          cwd: '/home/alice/repo',
          env: WORKER_ENV,
          runtimeAuthority: RUNTIME_AUTHORITY
        },
        LEGACY_FALLBACK_OPTIONS
      )

      const output = JSON.parse(peek.stdout) as {
        result: { formatted: string }
      }
      expect(output).toMatchObject({
        result: {
          messages: [{ id: message.id }],
          formatted: expect.stringContaining('inspect retained SSH mail'),
          legacyCompatibility: { readOnly: true }
        }
      })
      expect(output.result.formatted).toContain(`${message.id} [legacy, read-only]`)
      expect(output.result.formatted).toContain(
        'Inspection only: reply and acknowledgment are unavailable.'
      )
      expect(output.result.formatted).not.toContain('orchestration reply')
      expect(peek.postOutput).toBeUndefined()
      expect(db.getMessageById(message.id)?.read).toBe(0)
    } finally {
      db.close()
    }
  })

  it('reads and acknowledges current Run delivery', async () => {
    const { db, runtime, run } = createLegacyRuntime()
    const message = db.insertMessage({
      runId: run.id,
      from: WORKER_HANDLE,
      to: `run:${run.id}`,
      subject: 'current Run mail'
    })
    const baseRequest = {
      cwd: '/home/alice/repo',
      env: COORDINATOR_ENV,
      runtimeAuthority: RUNTIME_AUTHORITY
    }
    const spawn = vi.fn()
    const hostCliAvailable = {
      ...LEGACY_FALLBACK_OPTIONS,
      entryExists: () => true,
      spawn: spawn as HostCliPassthroughOptions['spawn']
    }

    try {
      const checked = await runRemoteOrcaCli(
        runtime,
        {
          ...baseRequest,
          argv: ['orchestration', 'check', '--run', run.id]
        },
        hostCliAvailable
      )
      expect(checked.stdout).toContain('Delivery ')
      expect(checked.stdout).toContain(`${message.id} [status] from=${WORKER_HANDLE}`)
      expect(spawn).not.toHaveBeenCalled()

      const checkedJson = await runRemoteOrcaCli(
        runtime,
        {
          ...baseRequest,
          argv: ['orchestration', 'check', '--run', run.id, '--json']
        },
        hostCliAvailable
      )
      const result = JSON.parse(checkedJson.stdout) as {
        result: { deliveryId: string; messages: { id: string }[] }
      }
      expect(result.result.messages).toEqual([expect.objectContaining({ id: message.id })])

      const acknowledged = await runRemoteOrcaCli(
        runtime,
        {
          ...baseRequest,
          argv: [
            'orchestration',
            'check',
            '--run',
            run.id,
            '--ack',
            result.result.deliveryId,
            '--json'
          ]
        },
        hostCliAvailable
      )

      expect(JSON.parse(acknowledged.stdout)).toMatchObject({
        result: { acknowledged: result.result.deliveryId }
      })
      expect(db.getMessageById(message.id)?.read).toBe(1)
    } finally {
      db.close()
    }
  })

  it('replays an SSH legacy ask by retry request without creating another question', async () => {
    const { db, runtime } = createLegacyRuntime()
    const argv = [
      'orchestration',
      'ask',
      '--to',
      COORDINATOR_HANDLE,
      '--question',
      'Continue?',
      '--timeout-ms',
      '1',
      '--retry-request',
      'ssh-question-1',
      '--json'
    ]
    const request = {
      argv,
      cwd: '/home/alice/repo',
      env: WORKER_ENV,
      runtimeAuthority: RUNTIME_AUTHORITY
    }

    try {
      const first = await runRemoteOrcaCli(runtime, request, LEGACY_FALLBACK_OPTIONS)
      const replay = await runRemoteOrcaCli(runtime, request, LEGACY_FALLBACK_OPTIONS)
      const sqlite = (db as unknown as { db: Database.Database }).db

      const firstResult = JSON.parse(first.stdout) as { messageId: string; timedOut: boolean }
      const replayResult = JSON.parse(replay.stdout) as { messageId: string; timedOut: boolean }
      expect(first).toMatchObject({ exitCode: 1 })
      expect(firstResult).toMatchObject({ messageId: expect.any(String), timedOut: true })
      expect(replay).toMatchObject({ exitCode: 1 })
      expect(replayResult).toMatchObject({ messageId: firstResult.messageId, timedOut: true })
      expect(
        (
          sqlite.prepare('SELECT COUNT(*) AS count FROM question_threads').get() as {
            count: number
          }
        ).count
      ).toBe(1)
    } finally {
      db.close()
    }
  })

  it('resumes and acknowledges a question answer', async () => {
    const { db, runtime, run, dispatch } = createLegacyRuntime()
    const pending = db.createQuestion({
      runId: run.id,
      dispatchId: dispatch.id,
      askerHandle: WORKER_HANDLE,
      question: 'Proceed?'
    })
    const answer = db.answerQuestion({
      messageId: pending.question.message_id,
      runId: run.id,
      consumerGeneration: run.consumer_generation,
      body: 'yes'
    })
    const sqlite = (db as unknown as { db: Database.Database }).db
    sqlite
      .prepare(
        `UPDATE messages
         SET delivery_contract = 'legacy_direct', read = 0
         WHERE id = ?`
      )
      .run(answer.message.id)

    try {
      const result = await runRemoteOrcaCli(
        runtime,
        {
          argv: ['orchestration', 'ask', '--resume', pending.question.message_id, '--json'],
          cwd: '/home/alice/repo',
          env: WORKER_ENV,
          runtimeAuthority: RUNTIME_AUTHORITY
        },
        LEGACY_FALLBACK_OPTIONS
      )

      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        answer: 'yes',
        messageId: pending.question.message_id,
        timedOut: false
      })
      expect(result.postOutput).toEqual({
        kind: 'legacy_question_ack',
        terminal: WORKER_HANDLE,
        questionId: pending.question.message_id,
        answerMessageId: answer.message.id
      })
      expect(db.getMessageById(answer.message.id)?.read).toBe(0)

      await acknowledgeRemoteOrcaCliPostOutput(runtime, {
        postOutput: result.postOutput!,
        env: WORKER_ENV,
        runtimeAuthority: RUNTIME_AUTHORITY
      })

      expect(db.getMessageById(answer.message.id)?.read).toBe(1)
    } finally {
      db.close()
    }
  })
})
