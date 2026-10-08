import { readTestAgentSessionOperationRows } from './agent-session-operation-test-rows'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import { closeTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  openTestAgentSessionRecordStore,
  editPersistedTestAgentSessionStore
} from './agent-session-record-store-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import { AgentSessionCreateReceiptSchema } from './agent-session-create-receipt'
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

async function runtime() {
  const service = new OrcaRuntimeService(null)
  const store = await openTestAgentSessionRecordStore(directory)
  const reconcile = vi.fn<() => Promise<RuntimeTerminalCreate | null>>(async () => null)
  Object.assign(service, {
    store: {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    },
    resolveTerminalWorkspaceLaunchScope: async () => ({
      id: 'folder-1',
      path: directory,
      connectionId: null
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
    restarted.reconcile.mockResolvedValue(original.terminal)
    await expect(
      restarted.service.createAgentSession(action, { clientId: 'paired-device' })
    ).resolves.toMatchObject({
      disposition: 'replayed',
      terminal: { handle: original.terminal.handle }
    })
    expect(duplicate).not.toHaveBeenCalled()
  })

  it('adopts a surviving spawn when its response was lost before the restart', async () => {
    const first = await runtime()
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
    const restarted = await runtime()
    const duplicate = vi
      .spyOn(restarted.service, 'createTerminal')
      .mockResolvedValue(terminal('duplicate'))
    restarted.reconcile.mockResolvedValue(terminal(handle))
    await expect(restarted.service.createAgentSession(action)).resolves.toMatchObject({
      disposition: 'replayed',
      terminal: { handle }
    })
    expect(duplicate).not.toHaveBeenCalled()
  })

  it('records the resolved launch, stable identity and host before dispatch', async () => {
    const first = await runtime()
    const action = request()
    vi.spyOn(first.service, 'createTerminal').mockImplementation(async (_scope, options) => {
      const row = first.store.getOperationRow('trusted-local:runtime', action.clientOperationId)
      expect(row?.outcome.status).toBe('unknown')
      const receipt = AgentSessionCreateReceiptSchema.parse(row?.terminalCreate)
      expect(receipt).toMatchObject({
        hostId: 'local',
        connectionId: null,
        worktreeId: 'folder-1',
        workspacePath: directory,
        terminalHandle: options?.preAllocatedHandle,
        executionOperationId: options?.agentSessionCreateOperationId,
        startup: { launchCommand: options?.command },
        resolvedRequest: { worktree: 'id:folder-1', prompt: action.prompt }
      })
      return terminal(receipt.terminalHandle)
    })
    await first.service.createAgentSession(action)
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
    await expect(restarted.service.createAgentSession(action)).rejects.toThrow('connection lost')
    await expect(restarted.service.createAgentSession(action)).rejects.toThrow('connection lost')
    restarted.reconcile.mockResolvedValue(terminal(handle))
    await expect(restarted.service.createAgentSession(action)).resolves.toMatchObject({
      disposition: 'replayed',
      terminal: { handle }
    })
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
    expect(duplicate).not.toHaveBeenCalled()
  })

  it('retries a proven pre-dispatch failure with the recorded plan after restart', async () => {
    const first = await runtime()
    const create = vi
      .spyOn(first.service, 'createTerminal')
      .mockRejectedValue(new Error('preflight failed'))
    const action = request()
    await expect(first.service.createAgentSession(action)).rejects.toThrow('preflight failed')
    const original = create.mock.calls[0]?.[1]
    closeTestJournalHostDatabase(directory)
    const restarted = await runtime()
    Object.assign(restarted.service, {
      store: {
        getSettings: () => {
          throw new Error('do not rebuild a recorded plan')
        }
      }
    })
    const retry = vi
      .spyOn(restarted.service, 'createTerminal')
      .mockResolvedValue(terminal(original?.preAllocatedHandle ?? ''))
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

  it('replays a retained receipt after new admission has expired, then refuses after retention', async () => {
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

  it('keeps an unreadable create receipt fenced after restart', async () => {
    const first = await runtime()
    vi.spyOn(first.service, 'createTerminal').mockResolvedValue(terminal('original'))
    const action = request()
    await first.service.createAgentSession(action)
    await editPersistedTestAgentSessionStore(directory, (persisted) => {
      for (const row of Object.values(persisted.operations)) {
        row.terminalCreate = { version: 999 }
      }
    })
    closeTestJournalHostDatabase(directory)
    const restarted = await runtime()
    const create = vi.spyOn(restarted.service, 'createTerminal')
    await expect(restarted.service.createAgentSession(action)).rejects.toThrow(
      'agent_session_operation_unknown'
    )
    expect(create).not.toHaveBeenCalled()
    expect(readTestAgentSessionOperationRows(restarted.store)).toHaveLength(1)
  })

  it('never dispatches without a durable claim and permits a later retry', async () => {
    const first = await runtime()
    const claim = vi
      .spyOn(first.store, 'admitAndClaimOperation')
      .mockRejectedValueOnce(new Error('disk unavailable'))
    const create = vi.spyOn(first.service, 'createTerminal').mockResolvedValue(terminal('original'))
    const action = request()
    await expect(first.service.createAgentSession(action)).rejects.toThrow('disk unavailable')
    expect(create).not.toHaveBeenCalled()
    await expect(first.service.createAgentSession(action)).resolves.toMatchObject({
      disposition: 'created'
    })
    expect(claim).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledOnce()
  })
})
