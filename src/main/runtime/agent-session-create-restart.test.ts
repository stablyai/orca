import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import { closeTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  openTestAgentSessionRecordStore,
  editPersistedTestAgentSessionStore,
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionStoreFromNewerBuild
} from './agent-session-record-store-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  type RuntimeCreateAgentSessionRequest
} from '../../shared/agent-session-host-authority'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-create-restart-'))
})

afterEach(async () => {
  closeTestJournalHostDatabase(directory)
  vi.restoreAllMocks()
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})

function request(): RuntimeCreateAgentSessionRequest {
  return {
    worktree: 'id:folder-1',
    agent: 'codex',
    prompt: 'continue work',
    clientOperationId: `${Date.now()}-${'a'.repeat(32)}`
  }
}

function settings(disabledTuiAgents: string[] = []) {
  return {
    getSettings: () => ({
      disabledTuiAgents,
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: { codex: { OPENAI_API_KEY: 'sk-secret-123' } }
    })
  }
}

async function runtime(connectionId: string | null = null) {
  const service = new OrcaRuntimeService(null)
  const store = await openTestAgentSessionRecordStore(directory)
  const reconcile = vi.fn<
    (
      worktreeId: string,
      handle: string,
      connectionId?: string | null
    ) => Promise<RuntimeTerminalCreate | null>
  >(async () => null)
  Object.assign(service, {
    store: settings(),
    resolveTerminalWorkspaceLaunchScope: async () => ({
      id: 'folder-1',
      path: directory,
      connectionId
    }),
    reconcileRemoteTerminalCreate: reconcile
  })
  vi.spyOn(service, 'openAgentSessionRecordStore').mockResolvedValue(store)
  return { service, store, reconcile }
}

function terminal(handle: string): RuntimeTerminalCreate {
  return {
    handle,
    ptyId: 'surviving-pty',
    worktreeId: 'folder-1',
    title: null,
    surface: 'background'
  }
}

describe('terminal agent creation across a runtime restart', () => {
  it('replays the same paired-client action after the runtime restarts', async () => {
    const first = await runtime()
    const create = vi
      .spyOn(first.service, 'createTerminal')
      .mockImplementation(async (_scope, options) => {
        return terminal(options?.preAllocatedHandle ?? '')
      })
    const action = request()
    const original = await first.service.createAgentSession(action, { clientId: 'paired-device' })
    expect(create).toHaveBeenCalledOnce()

    closeTestJournalHostDatabase(directory)
    const restarted = await runtime()
    const duplicate = vi
      .spyOn(restarted.service, 'createTerminal')
      .mockResolvedValue(terminal('duplicate'))
    const write = vi.spyOn(restarted.store, 'recordOperationOutcome')
    await expect(
      restarted.service.createAgentSession(action, { clientId: 'paired-device' })
    ).resolves.toEqual({ disposition: 'replayed', terminal: original.terminal })
    expect(duplicate).not.toHaveBeenCalled()
    // A recorded answer needs neither an inventory listing nor a rewrite.
    expect(restarted.reconcile).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it.each([
    ['a local', null],
    ['an SSH', 'ssh-1']
  ])('adopts %s spawn whose response was lost before the restart', async (_host, connectionId) => {
    const first = await runtime(connectionId)
    let handle = ''
    vi.spyOn(first.service, 'createTerminal').mockImplementation(async (_scope, options) => {
      handle = options?.preAllocatedHandle ?? ''
      options?.onPtySpawnDispatched?.()
      options?.onPtySpawnCommitted?.()
      throw Object.assign(new Error('connection lost'), { agentSessionOperationOutcome: 'unknown' })
    })
    const action = request()
    await expect(first.service.createAgentSession(action)).rejects.toThrow('connection lost')

    closeTestJournalHostDatabase(directory)
    const restarted = await runtime(connectionId)
    const duplicate = vi
      .spyOn(restarted.service, 'createTerminal')
      .mockResolvedValue(terminal('duplicate'))
    restarted.reconcile.mockResolvedValue(terminal(handle))
    await expect(restarted.service.createAgentSession(action)).resolves.toMatchObject({
      disposition: 'replayed',
      terminal: { handle }
    })
    expect(restarted.reconcile).toHaveBeenCalledWith('folder-1', handle, connectionId)
    expect(duplicate).not.toHaveBeenCalled()
  })

  it('records only the terminal identity before dispatch, never the launch plan', async () => {
    const first = await runtime()
    const action = request()
    vi.spyOn(first.service, 'createTerminal').mockImplementation(async (_scope, options) => {
      const row = first.store.getOperationRow('trusted-local:runtime', action.clientOperationId)
      expect(row?.outcome.status).toBe('unknown')
      expect(row?.terminalTarget).toEqual({
        version: 1,
        executionOperationId: options?.agentSessionCreateOperationId,
        worktreeId: 'folder-1',
        connectionId: null,
        terminalHandle: options?.preAllocatedHandle,
        tabId: options?.tabId,
        leafId: options?.leafId
      })
      return terminal(options?.preAllocatedHandle ?? '')
    })
    await first.service.createAgentSession(action)
    const persisted = JSON.stringify(await readPersistedTestAgentSessionStore(directory))
    expect(persisted).not.toContain(action.prompt)
    expect(persisted).not.toContain('sk-secret-123')
  })

  it('re-derives an uncertain result when the host becomes reachable', async () => {
    const first = await runtime()
    let handle = ''
    vi.spyOn(first.service, 'createTerminal').mockImplementation(async (_scope, options) => {
      handle = options?.preAllocatedHandle ?? ''
      options?.onPtySpawnDispatched?.()
      throw new Error('connection lost')
    })
    const action = request()
    await expect(first.service.createAgentSession(action)).rejects.toThrow('connection lost')
    closeTestJournalHostDatabase(directory)
    const restarted = await runtime()
    const duplicate = vi.spyOn(restarted.service, 'createTerminal')
    restarted.reconcile.mockRejectedValueOnce(new Error('host offline')).mockResolvedValueOnce(null)
    await expect(restarted.service.createAgentSession(action)).rejects.toThrow(
      'agent_session_operation_unknown'
    )
    await expect(restarted.service.createAgentSession(action)).rejects.toThrow(
      'agent_session_operation_unknown'
    )
    restarted.reconcile.mockResolvedValue(terminal(handle))
    await expect(restarted.service.createAgentSession(action)).resolves.toMatchObject({
      disposition: 'replayed',
      terminal: { handle }
    })
    expect(restarted.reconcile).toHaveBeenCalledTimes(3)
    for (const call of restarted.reconcile.mock.calls) {
      expect(call).toEqual(['folder-1', handle, null])
    }
    expect(duplicate).not.toHaveBeenCalled()
  })

  it('replays a stable refusal code after restart, never stale first-attempt text', async () => {
    const first = await runtime()
    vi.spyOn(first.service, 'createTerminal').mockImplementation(async (_scope, options) => {
      options?.onPtySpawnDispatched?.()
      throw new Error('agent_session_exited_during_start')
    })
    const action = request()
    await expect(first.service.createAgentSession(action)).rejects.toThrow(
      'agent_session_exited_during_start'
    )
    closeTestJournalHostDatabase(directory)
    const restarted = await runtime()
    const duplicate = vi.spyOn(restarted.service, 'createTerminal')
    await expect(restarted.service.createAgentSession(action)).rejects.toThrow(
      'agent_session_exited_during_start'
    )
    expect(duplicate).not.toHaveBeenCalled()
  })

  it('returns a created terminal even when outcome settlement fails', async () => {
    const first = await runtime()
    vi.spyOn(first.store, 'recordOperationOutcome').mockRejectedValue(new Error('disk unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(first.service, 'createTerminal').mockImplementation(async (_scope, options) =>
      terminal(options?.preAllocatedHandle ?? '')
    )
    const action = request()
    const result = await first.service.createAgentSession(action)
    expect(result.disposition).toBe('created')
    closeTestJournalHostDatabase(directory)
    const restarted = await runtime()
    const duplicate = vi.spyOn(restarted.service, 'createTerminal')
    restarted.reconcile.mockResolvedValue(result.terminal)
    await expect(restarted.service.createAgentSession(action)).resolves.toMatchObject({
      disposition: 'replayed'
    })
    expect(restarted.reconcile).toHaveBeenCalledWith('folder-1', result.terminal.handle, null)
    expect(duplicate).not.toHaveBeenCalled()
  })

  it('re-runs every launch check for a proven pre-dispatch failure after restart', async () => {
    const first = await runtime()
    const create = vi
      .spyOn(first.service, 'createTerminal')
      .mockRejectedValue(new Error('preflight failed'))
    const action = request()
    await expect(first.service.createAgentSession(action)).rejects.toThrow('preflight failed')
    const original = create.mock.calls[0]?.[1]
    closeTestJournalHostDatabase(directory)
    const restarted = await runtime()
    const retry = vi
      .spyOn(restarted.service, 'createTerminal')
      .mockResolvedValue(terminal(original?.preAllocatedHandle ?? ''))
    Object.assign(restarted.service, { store: settings(['codex']) })
    await expect(restarted.service.createAgentSession(action)).rejects.toThrow(
      'Selected agent is disabled'
    )
    expect(retry).not.toHaveBeenCalled()
    Object.assign(restarted.service, { store: settings() })
    await expect(restarted.service.createAgentSession(action)).resolves.toMatchObject({
      disposition: 'created'
    })
    expect(retry.mock.calls[0]?.[1]).toMatchObject({
      command: original?.command,
      preAllocatedHandle: original?.preAllocatedHandle,
      agentSessionCreateOperationId: original?.agentSessionCreateOperationId
    })
  })

  it('retains a claim interrupted before dispatch and allows a new action', async () => {
    const first = await runtime()
    const action = request()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(first.store, 'recordOperationOutcome').mockRejectedValue(new Error('runtime stopped'))
    vi.spyOn(first.service, 'createTerminal').mockRejectedValue(new Error('runtime stopped'))
    await expect(first.service.createAgentSession(action)).rejects.toThrow('runtime stopped')
    closeTestJournalHostDatabase(directory)
    const restarted = await runtime()
    const create = vi
      .spyOn(restarted.service, 'createTerminal')
      .mockResolvedValue(terminal('new-action'))
    await expect(restarted.service.createAgentSession(action)).rejects.toThrow(
      'agent_session_operation_unknown'
    )
    await expect(
      restarted.service.createAgentSession({
        ...action,
        clientOperationId: `${Date.now()}-${'b'.repeat(32)}`
      })
    ).resolves.toMatchObject({ disposition: 'created' })
    expect(create).toHaveBeenCalledOnce()
  })

  it('rejects a changed request across a restart without resolving the workspace', async () => {
    const first = await runtime()
    vi.spyOn(first.service, 'createTerminal').mockResolvedValue(terminal('original'))
    const action = request()
    await first.service.createAgentSession(action)
    closeTestJournalHostDatabase(directory)
    const restarted = await runtime()
    Object.assign(restarted.service, {
      resolveTerminalWorkspaceLaunchScope: () => {
        throw new Error('workspace deleted')
      }
    })
    await expect(
      restarted.service.createAgentSession({ ...action, prompt: 'changed' })
    ).rejects.toThrow('agent_session_operation_conflict')
    await expect(restarted.service.createAgentSession(action)).resolves.toMatchObject({
      disposition: 'replayed'
    })
  })

  it('replays a retained create after new admission has expired, then refuses after retention', async () => {
    const first = await runtime()
    vi.spyOn(first.service, 'createTerminal').mockResolvedValue(terminal('original'))
    const now = Date.now()
    const action = {
      ...request(),
      clientOperationId: `${now + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS}-${'a'.repeat(32)}`
    }
    await first.service.createAgentSession(action)
    closeTestJournalHostDatabase(directory)
    const restarted = await runtime()
    const create = vi.spyOn(restarted.service, 'createTerminal')
    vi.spyOn(Date, 'now').mockReturnValue(
      now + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 1
    )
    await expect(restarted.service.createAgentSession(action)).resolves.toMatchObject({
      disposition: 'replayed'
    })
    vi.mocked(Date.now).mockReturnValue(
      now + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + 2 * AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 1
    )
    await expect(restarted.service.createAgentSession(action)).rejects.toThrow(
      'agent_session_operation_expired'
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('replays a recorded success whose terminal target is unreadable', async () => {
    const first = await runtime()
    vi.spyOn(first.service, 'createTerminal').mockResolvedValue(terminal('original'))
    const action = request()
    await first.service.createAgentSession(action)
    await editPersistedTestAgentSessionStore(directory, (persisted) => {
      for (const row of Object.values(persisted.operations)) {
        row.terminalTarget = { version: 999 }
      }
    })
    closeTestJournalHostDatabase(directory)
    const restarted = await runtime()
    const create = vi.spyOn(restarted.service, 'createTerminal')
    await expect(restarted.service.createAgentSession(action)).resolves.toMatchObject({
      disposition: 'replayed',
      terminal: { handle: 'original' }
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps an unknown create fenced when its terminal target is unreadable', async () => {
    const first = await runtime()
    vi.spyOn(first.service, 'createTerminal').mockImplementation(async (_scope, options) => {
      options?.onPtySpawnDispatched?.()
      throw new Error('connection lost')
    })
    const action = request()
    await expect(first.service.createAgentSession(action)).rejects.toThrow('connection lost')
    await editPersistedTestAgentSessionStore(directory, (persisted) => {
      for (const row of Object.values(persisted.operations)) {
        row.terminalTarget = { version: 999 }
      }
    })
    closeTestJournalHostDatabase(directory)
    const restarted = await runtime()
    const create = vi.spyOn(restarted.service, 'createTerminal')
    await expect(restarted.service.createAgentSession(action)).rejects.toThrow(
      'agent_session_operation_unknown'
    )
    expect(restarted.reconcile).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(restarted.store.listOperationRows()).toHaveLength(1)
  })

  it('adopts an uncertain spawn under the recorded pane, not the listing placeholders', async () => {
    const first = await runtime()
    const create = vi
      .spyOn(first.service, 'createTerminal')
      .mockImplementation(async (_scope, options) => {
        options?.onPtySpawnDispatched?.()
        throw new Error('connection lost')
      })
    const action = request()
    await expect(first.service.createAgentSession(action)).rejects.toThrow('connection lost')
    const launched = create.mock.calls[0]?.[1]
    first.reconcile.mockResolvedValue(terminal(launched?.preAllocatedHandle ?? ''))
    const adopted = await first.service.createAgentSession(action)
    expect(first.reconcile).toHaveBeenCalledWith('folder-1', launched?.preAllocatedHandle, null)
    expect(adopted).toMatchObject({
      disposition: 'replayed',
      terminal: {
        handle: launched?.preAllocatedHandle,
        tabId: launched?.tabId,
        paneKey: `${launched?.tabId}:${launched?.leafId}`
      }
    })
    first.reconcile.mockClear()
    await expect(first.service.createAgentSession(action)).resolves.toEqual(adopted)
    expect(first.reconcile).not.toHaveBeenCalled()
  })

  it('persists only the known fields of the answer it returns', async () => {
    const first = await runtime()
    vi.spyOn(first.service, 'createTerminal').mockImplementation(async (_scope, options) => ({
      ...terminal(options?.preAllocatedHandle ?? ''),
      launchEnvLeak: 'sk-unreviewed-field'
    }))
    await first.service.createAgentSession(request())
    const persisted = JSON.stringify(await readPersistedTestAgentSessionStore(directory))
    expect(persisted).toContain('surviving-pty')
    expect(persisted).not.toContain('launchEnvLeak')
    expect(persisted).not.toContain('sk-unreviewed-field')
  })
})

describe('terminal agent creation when its record cannot be written', () => {
  async function degradedRuntime() {
    const degraded = await runtime()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(degraded.service.openAgentSessionRecordStore).mockRejectedValue(
      new Error('agent_session_journal_unreadable')
    )
    return degraded
  }

  it('adopts a lost spawn on a same-ID retry and never starts a second agent', async () => {
    const { service, reconcile } = await degradedRuntime()
    const create = vi.spyOn(service, 'createTerminal').mockImplementation(async (_s, options) => {
      options?.onPtySpawnDispatched?.()
      throw new Error('connection lost')
    })
    const action = request()
    await expect(service.createAgentSession(action)).rejects.toThrow('connection lost')
    const handle = create.mock.calls[0]?.[1]?.preAllocatedHandle ?? ''
    await expect(service.createAgentSession(action)).rejects.toThrow(
      'agent_session_operation_unknown'
    )
    reconcile.mockResolvedValue(terminal(handle))
    await expect(service.createAgentSession(action)).resolves.toMatchObject({
      disposition: 'replayed',
      terminal: { handle }
    })
    expect(reconcile).toHaveBeenLastCalledWith('folder-1', handle, null)
    reconcile.mockClear()
    await expect(service.createAgentSession(action)).resolves.toMatchObject({
      disposition: 'replayed',
      terminal: { handle }
    })
    expect(reconcile).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledOnce()
  })

  it('adopts a lost spawn for a retry that joined it in flight', async () => {
    const { service, reconcile } = await degradedRuntime()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const create = vi.spyOn(service, 'createTerminal').mockImplementation(async (_s, options) => {
      options?.onPtySpawnDispatched?.()
      await gate
      throw new Error('client_disconnected')
    })
    const action = request()
    const first = service.createAgentSession(action, { clientId: 'device-a' })
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    const retry = service.createAgentSession(action, { clientId: 'device-a' })
    const handle = create.mock.calls[0]?.[1]?.preAllocatedHandle ?? ''
    reconcile.mockResolvedValue(terminal(handle))
    release()
    await expect(first).rejects.toThrow('client_disconnected')
    await expect(retry).resolves.toMatchObject({ disposition: 'replayed', terminal: { handle } })
    expect(create).toHaveBeenCalledOnce()
  })

  it('still starts the agent when the claim cannot be recorded, and replays it in process', async () => {
    const first = await runtime()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(first.store, 'admitAndClaimOperation').mockRejectedValue(new Error('disk unavailable'))
    const create = vi
      .spyOn(first.service, 'createTerminal')
      .mockImplementation(async (_scope, options) => terminal(options?.preAllocatedHandle ?? ''))
    const action = request()
    const created = await first.service.createAgentSession(action)
    expect(created.disposition).toBe('created')
    await expect(first.service.createAgentSession(action)).resolves.toEqual({
      ...created,
      disposition: 'replayed'
    })
    expect(create).toHaveBeenCalledOnce()
  })

  it('still starts the agent when the store cannot be opened, and replays it in process', async () => {
    const first = await runtime()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(first.service.openAgentSessionRecordStore).mockRejectedValue(
      new Error('agent_session_journal_unreadable')
    )
    const create = vi
      .spyOn(first.service, 'createTerminal')
      .mockImplementation(async (_scope, options) => terminal(options?.preAllocatedHandle ?? ''))
    const action = request()
    await expect(first.service.createAgentSession(action)).resolves.toMatchObject({
      disposition: 'created'
    })
    await expect(first.service.createAgentSession(action)).resolves.toMatchObject({
      disposition: 'replayed'
    })
    expect(create).toHaveBeenCalledOnce()
  })

  it('replays recorded creates from a store a newer Orca wrote, and starts new ones', async () => {
    const first = await runtime()
    vi.spyOn(first.service, 'createTerminal').mockResolvedValue(terminal('before-downgrade'))
    const recorded = request()
    await first.service.createAgentSession(recorded)
    closeTestJournalHostDatabase(directory)
    await seedTestAgentSessionStoreFromNewerBuild(directory)
    const downgraded = await runtime()
    expect(downgraded.store.readOnly).toBe(true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const create = vi
      .spyOn(downgraded.service, 'createTerminal')
      .mockImplementationOnce(async (_scope, options) =>
        terminal(options?.preAllocatedHandle ?? '')
      )
      .mockImplementationOnce(async (_scope, options) => {
        options?.onPtySpawnDispatched?.()
        throw new Error('connection lost')
      })
    await expect(downgraded.service.createAgentSession(recorded)).resolves.toMatchObject({
      disposition: 'replayed',
      terminal: { handle: 'before-downgrade' }
    })
    const fresh = { ...request(), clientOperationId: `${Date.now()}-${'b'.repeat(32)}` }
    await expect(downgraded.service.createAgentSession(fresh)).resolves.toMatchObject({
      disposition: 'created'
    })
    await expect(downgraded.service.createAgentSession(fresh)).resolves.toMatchObject({
      disposition: 'replayed'
    })
    const uncertain = { ...request(), clientOperationId: `${Date.now()}-${'c'.repeat(32)}` }
    await expect(downgraded.service.createAgentSession(uncertain)).rejects.toThrow(
      'connection lost'
    )
    await expect(downgraded.service.createAgentSession(uncertain)).rejects.toThrow(
      'agent_session_operation_unknown'
    )
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('replays a create the store could not claim, ahead of its pending durable row', async () => {
    const { service, store } = await runtime()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const create = vi
      .spyOn(service, 'createTerminal')
      .mockRejectedValueOnce(new Error('preflight failed'))
      .mockImplementation(async (_scope, options) => terminal(options?.preAllocatedHandle ?? ''))
    const action = request()
    await expect(service.createAgentSession(action)).rejects.toThrow('preflight failed')
    vi.spyOn(store, 'admitAndClaimOperation').mockRejectedValueOnce(new Error('SQLITE_BUSY'))
    const created = await service.createAgentSession(action)
    expect(created.disposition).toBe('created')
    expect(
      store.getOperationRow('trusted-local:runtime', action.clientOperationId)?.outcome
    ).toEqual({ status: 'pending' })
    await expect(service.createAgentSession(action)).resolves.toEqual({
      ...created,
      disposition: 'replayed'
    })
    expect(create).toHaveBeenCalledTimes(2)
  })
})

describe('a retry that joins an in-flight create', () => {
  it('adopts the spawn the first caller lost instead of taking its failure', async () => {
    const { service, reconcile } = await runtime()
    let handle = ''
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const create = vi.spyOn(service, 'createTerminal').mockImplementation(async (_s, options) => {
      handle = options?.preAllocatedHandle ?? ''
      options?.onPtySpawnDispatched?.()
      await gate
      throw Object.assign(new Error('client_disconnected'), {
        agentSessionOperationOutcome: 'unknown'
      })
    })
    const action = request()
    const first = service.createAgentSession(action, { clientId: 'device-a' })
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    const retry = service.createAgentSession(action, { clientId: 'device-a' })
    reconcile.mockImplementation(async () => terminal(handle))
    release()
    await expect(first).rejects.toThrow('client_disconnected')
    await expect(retry).resolves.toMatchObject({ disposition: 'replayed', terminal: { handle } })
    expect(create).toHaveBeenCalledOnce()
  })

  it('starts the agent under its own connection when the first one dropped before dispatch', async () => {
    const { service } = await runtime()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const create = vi
      .spyOn(service, 'createTerminal')
      .mockImplementationOnce(async () => {
        await gate
        throw new Error('client_disconnected')
      })
      .mockImplementation(async (_s, options) => terminal(options?.preAllocatedHandle ?? ''))
    const action = request()
    const firstSignal = new AbortController().signal
    const retrySignal = new AbortController().signal
    const first = service.createAgentSession(action, { clientId: 'device-a', signal: firstSignal })
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    const retry = service.createAgentSession(action, { clientId: 'device-a', signal: retrySignal })
    const joined = service.createAgentSession(action, { clientId: 'device-a' })
    release()
    await expect(first).rejects.toThrow('client_disconnected')
    const [retried, alsoJoined] = await Promise.all([retry, joined])
    expect(retried.disposition).toBe('created')
    expect(alsoJoined).toEqual({ ...retried, disposition: 'replayed' })
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[1]?.[1]?.signal).toBe(retrySignal)
  })
})
