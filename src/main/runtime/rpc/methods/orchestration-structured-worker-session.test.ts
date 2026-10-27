import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../../shared/execution-host'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentMessageSource } from '../../../../shared/agent-session/agent-session-message-source'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { DISPATCH_REJECTED_WRITE_FAILED } from '../../../../shared/structured-agent-session-dispatch-rejection'

const hostRef: { current: unknown } = { current: null }
const createSpy = vi.fn()

vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (...args: unknown[]) => createSpy(...args)
}))

const {
  createStructuredWorkerSession,
  releaseStructuredWorkerSession,
  sendStructuredWorkerPreamble
} = await import('./orchestration-structured-worker-session')
const { isUnknownWorkerStartOutcome } = await import('./orchestration/worker/worker-topology')
const { structuredWorkerIdentities } = await import('../../structured-worker-identity')
const { sealedChildEnv } = await import('../../structured-session-child-env.test-support')

function installHost(
  location: Pick<AgentSessionExecutionLocation, 'executionHostId' | 'wslDistro'> = {
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    wslDistro: null
  }
) {
  const dispose = vi.fn()
  const observeJournalPublications = vi.fn(() => dispose)
  hostRef.current = {
    setSessionTabVisibility: async () => {},
    close: async () => {},
    deps: {
      store: {
        requireWritableRecord: (sessionId: string) =>
          agentSessionRecordFixture({ sessionId, location })
      }
    },
    observeJournalPublications
  }
  return { observeJournalPublications, dispose }
}

describe('structured worker session', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    createSpy.mockReset()
    createSpy.mockImplementation(async (args: { envelope: { sessionId: string } }) => ({
      ok: true,
      value: { sessionId: args.envelope.sessionId }
    }))
  })

  it('binds only a journal observer at start, and settlement drops it', async () => {
    const { observeJournalPublications, dispose } = installHost()
    const created = await createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      worktreeId: 'wt_1',
      agent: 'claude',
      dispatchId: 'd1',
      onJournalActivity: () => {}
    })
    // No hold: while the dispatch is open the idle sweep reads it from the orchestration database.
    expect(hostRef.current).not.toHaveProperty('hold')
    expect(observeJournalPublications).toHaveBeenCalledWith(
      created.identity.sessionId,
      expect.any(Function)
    )
    expect(dispose).not.toHaveBeenCalled()

    releaseStructuredWorkerSession('d1')
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(structuredWorkerIdentities.get(created.identity.handle)).toBeNull()
    releaseStructuredWorkerSession('d1')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('registers the identity BEFORE the session is created, so the child gets the handle', async () => {
    installHost()
    let envAtSpawn: Record<string, string> | undefined
    createSpy.mockImplementation(async (args: { envelope: { sessionId: string } }) => {
      // Register worker identity before attach reads the child environment, or ORCA_TERMINAL_HANDLE is absent.
      envAtSpawn = sealedChildEnv(args.envelope.sessionId)
      return { ok: true, value: { sessionId: args.envelope.sessionId } }
    })
    const created = await createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      worktreeId: 'wt_1',
      agent: 'claude',
      dispatchId: 'd_spawn',
      onJournalActivity: () => {}
    })
    expect(envAtSpawn?.ORCA_TERMINAL_HANDLE).toBe(created.identity.handle)
    // This app's own launcher by absolute path, so a login shell's profile cannot swap in a global.
    expect(envAtSpawn?.ORCA_CLI_COMMAND).toBe(
      join(
        getAppEnvironment().getPath('userData'),
        'cli',
        'bin',
        process.platform === 'win32' ? 'orca-dev.cmd' : 'orca-dev'
      )
    )
    expect(envAtSpawn?.ORCA_PANE_KEY).toBeUndefined()
    releaseStructuredWorkerSession('d_spawn')
  })

  it('forgets the identity and discards the session when the start fails', async () => {
    // A session that resolves outside the local host is not a worker this runtime can own.
    installHost({ executionHostId: 'local', wslDistro: 'Ubuntu' })
    const closed: string[] = []
    ;(hostRef.current as { close: (id: string) => Promise<void> }).close = async (id) => {
      closed.push(id)
    }
    await expect(
      createStructuredWorkerSession({
        runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
        worktreeId: 'wt_1',
        agent: 'claude',
        dispatchId: 'd_fail',
        onJournalActivity: () => {}
      })
    ).rejects.toThrow(/local execution host outside WSL/)
    // Neither a live provider child nor a registry entry may outlive the failed start.
    expect(closed).toHaveLength(1)
    expect(structuredWorkerIdentities.getBySessionId(closed[0]!)).toBeNull()
  })

  it('discards the session when the create settled UNKNOWN after attach', async () => {
    installHost()
    const closed: string[] = []
    ;(hostRef.current as { close: (id: string) => Promise<void> }).close = async (id) => {
      closed.push(id)
    }
    // operation_unknown after attach can leave a live provider child when only publication failed; failed start must retire it.
    createSpy.mockImplementation(async () => ({
      ok: false,
      refusal: {
        code: 'agent_session_operation_unknown',
        message: 'The chat may have been created, but its tab could not be confirmed.'
      }
    }))
    await expect(
      createStructuredWorkerSession({
        runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
        worktreeId: 'wt_1',
        agent: 'claude',
        dispatchId: 'd_unknown',
        onJournalActivity: () => {}
      })
    ).rejects.toThrow(/was refused/)
    expect(closed).toHaveLength(1)
    expect(structuredWorkerIdentities.getBySessionId(closed[0]!)).toBeNull()
  })

  it('does not close anything when the create refusal proves nothing was created', async () => {
    installHost()
    const closed: string[] = []
    ;(hostRef.current as { close: (id: string) => Promise<void> }).close = async (id) => {
      closed.push(id)
    }
    createSpy.mockImplementation(async () => ({
      ok: false,
      refusal: {
        code: 'structured_agent_session_unsupported',
        message: 'Orca cannot open a structured agent chat for this workspace.'
      }
    }))
    await expect(
      createStructuredWorkerSession({
        runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
        worktreeId: 'wt_1',
        agent: 'claude',
        dispatchId: 'd_definitive',
        onJournalActivity: () => {}
      })
    ).rejects.toThrow(/was refused/)
    expect(closed).toEqual([])
  })

  it('registers a random handle bound to the created session', async () => {
    installHost()
    const created = await createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      worktreeId: 'wt_1',
      agent: 'codex',
      dispatchId: 'd2',
      onJournalActivity: () => {}
    })
    expect(created.identity.handle.startsWith('structworker_')).toBe(true)
    expect(created.identity.processIncarnation).toBe(`structured:${created.identity.sessionId}`)
    expect(structuredWorkerIdentities.getBySessionId(created.identity.sessionId)?.agent).toBe(
      'codex'
    )
    releaseStructuredWorkerSession('d2')
  })

  it('does not activate the worker session, so a dispatch cannot steal the surface', async () => {
    installHost()
    await createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      worktreeId: 'wt_1',
      agent: 'claude',
      dispatchId: 'd3',
      onJournalActivity: () => {}
    })
    expect(createSpy.mock.calls[0]![0].activate).toBe(false)
    releaseStructuredWorkerSession('d3')
  })

  it('refuses a session pinned to a non-local execution host', async () => {
    installHost({ executionHostId: toSshExecutionHostId('ssh-1'), wslDistro: null })
    await expect(
      createStructuredWorkerSession({
        runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
        worktreeId: 'wt_1',
        agent: 'claude',
        dispatchId: 'd4',
        onJournalActivity: () => {}
      })
    ).rejects.toThrow(/local execution host/)
  })
})

describe('structured worker dispatch preamble', () => {
  type PreambleHost = Parameters<typeof sendStructuredWorkerPreamble>[0]['host']
  type Settled = Pick<AgentJournalSubmission, 'dispatchState' | 'reason'>

  function submissionOf(settled: Settled): AgentJournalSubmission {
    return {
      clientMessageId: 'c1',
      fence: 7,
      payloadFingerprint: 'fingerprint',
      providerItemId: null,
      submittedAt: 1,
      resolvedAt: null,
      ...settled
    }
  }

  function hostWithSubmission(submission: Settled, delivered?: Settled): PreambleHost {
    return {
      deps: {
        store: {
          selectWritableRecord: (sessionId) => ({
            kind: 'writable',
            record: agentSessionRecordFixture({ sessionId })
          }),
          requireWritableRecord: (sessionId) =>
            agentSessionRecordFixture({
              sessionId,
              lease: { ...agentSessionRecordFixture({ sessionId }).lease, runtimeFence: 7 }
            })
        }
      },
      send: async () => ({
        ok: true,
        replayed: false,
        fence: 7,
        cursor: { epoch: 'epoch-1', sequence: 1 },
        value: { clientMessageId: 'c1', submission: submissionOf(submission) }
      }),
      // What the submission settled as while the worker's agent started; undefined when the
      // start outlasted the wait.
      waitForSendSettlement: async () =>
        delivered
          ? {
              cursor: { epoch: 'epoch-1', sequence: 2 },
              value: { clientMessageId: 'c1', submission: submissionOf(delivered) }
            }
          : undefined
    }
  }

  const TASK_FROM: AgentMessageSource = {
    kind: 'agent',
    senders: [
      {
        party: { address: 'term_coord', terminalHandle: 'term_coord', orcaSessionId: null },
        name: 'Coordinator'
      }
    ],
    orchestration: { message: 'task', runId: 'r1', taskId: 't1', dispatchId: 'd1' }
  }

  const send = (host: PreambleHost) =>
    sendStructuredWorkerPreamble({
      host,
      sessionId: 's1',
      dispatchId: 'd1',
      preamble: 'spec',
      from: TASK_FROM
    })

  // No source and no person: a restart or a close rejects it, and orchestration re-derives it.
  it('sends the preamble as no person’s', async () => {
    const host = hostWithSubmission({ dispatchState: 'accepted', reason: null })
    const sent = vi.spyOn(host, 'send')
    await send(host)
    expect(sent.mock.calls[0]?.[1]).not.toHaveProperty('source')
    expect(sent.mock.calls[0]?.[1]).not.toHaveProperty('userSend')
  })

  it('names who the task is from on the turn it sends', async () => {
    const host = hostWithSubmission({ dispatchState: 'accepted', reason: null })
    const sent = vi.spyOn(host, 'send')
    await send(host)
    expect(sent.mock.calls[0]?.[1]).toMatchObject({ body: { from: TASK_FROM } })
  })

  it('reports the preamble delivered only on an accepted submission', async () => {
    await expect(
      send(hostWithSubmission({ dispatchState: 'accepted', reason: null }))
    ).resolves.toBe('accepted')
  })

  it('waits for an accepted preamble to be delivered, and reports that delivery (W10)', async () => {
    await expect(
      send(
        hostWithSubmission(
          { dispatchState: 'pending', reason: null },
          { dispatchState: 'accepted', reason: null }
        )
      )
    ).resolves.toBe('accepted')
  })

  it('reports a preamble still held for an agent that outlasted the wait, without failing the start (W10)', async () => {
    // Pending preamble is held for the starting agent; throwing would tear it down and reject text about to be delivered.
    await expect(
      send(hostWithSubmission({ dispatchState: 'pending', reason: null }))
    ).resolves.toBe('pending')
  })

  it('never claims delivery for a submission the provider never acknowledged', async () => {
    // Adapter throws settle as unknown despite performSend returning ok; claiming readiness strands the coordinator without a delivered task.
    const error = await send(
      hostWithSubmission({ dispatchState: 'unknown', reason: 'provider child exited' })
    ).catch((thrown: unknown) => thrown)
    expect((error as { code?: string }).code).toBe('operation_unknown')
    // Verify this reaches the outcome_unknown receipt with worker-show/abandon recovery commands.
    expect(isUnknownWorkerStartOutcome(error, 'dispatch_input')).toBe(true)
  })

  it('reads a queued answer as unacknowledged', async () => {
    const host: PreambleHost = {
      ...hostWithSubmission({ dispatchState: 'accepted', reason: null }),
      send: async () => ({
        ok: true,
        replayed: false,
        fence: 7,
        cursor: { epoch: 'epoch-1', sequence: 1 },
        value: { clientMessageId: 'c1', queued: { messageId: 'c1', position: 0, state: 'waiting' } }
      })
    }
    await expect(send(host)).rejects.toMatchObject({
      code: 'operation_unknown',
      message:
        'The dispatch preamble was submitted but not acknowledged (unknown): no reason given.'
    })
  })

  it('keeps a rejected preamble a proven failure under a code of its own', async () => {
    const error = await send(
      hostWithSubmission({ dispatchState: 'rejected', reason: 'fence moved' })
    ).catch((thrown: unknown) => thrown)
    // A typed verdict distinguishes definite non-delivery from operation_unknown without parsing prose.
    expect((error as { code?: string }).code).toBe('dispatch_preamble_undelivered')
    expect((error as Error).message).toMatch(/not delivered: fence moved/)
    expect(isUnknownWorkerStartOutcome(error, 'dispatch_input')).toBe(false)
  })

  it('ends the message with one period whether the reason is a sentence or a marker', async () => {
    const sentence = await send(
      hostWithSubmission({
        dispatchState: 'rejected',
        reason: 'The provider stopped before this message was sent.'
      })
    ).catch((thrown: unknown) => thrown)
    expect(sentence).toMatchObject({
      message:
        'The dispatch preamble was not delivered: The provider stopped before this message was sent.'
    })
    const marker = await send(
      hostWithSubmission({ dispatchState: 'unknown', reason: 'provider child exited' })
    ).catch((thrown: unknown) => thrown)
    expect(marker).toMatchObject({
      message:
        'The dispatch preamble was submitted but not acknowledged (unknown): provider child exited.'
    })
  })

  it('reports a refused transport write as undelivered, never as unknown', async () => {
    // Provably unwritten input has no running turn to inspect; report definitive non-delivery.
    const error = await send(
      hostWithSubmission({
        dispatchState: 'rejected',
        reason: DISPATCH_REJECTED_WRITE_FAILED
      })
    ).catch((thrown: unknown) => thrown)
    expect((error as { code?: string }).code).toBe('dispatch_preamble_undelivered')
    expect(isUnknownWorkerStartOutcome(error, 'dispatch_input')).toBe(false)
  })
})
