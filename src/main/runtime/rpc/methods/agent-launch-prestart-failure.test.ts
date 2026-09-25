/**
 * A terminal launch that fails before its spawn is requested — agent disabled, no launch command,
 * runtime unavailable — created nothing, so a named operation settles as failed with its real cause.
 * Once the request has left, a failure proves nothing and the outcome stays unknown.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionRecordStore } from '../../agent-session-record-store'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { methodNamed, runtimeStub, type AgentLaunchRuntimeStub } from './agent-launch.test-fixture'

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async () => ({
    ok: true,
    value: { sessionId: 'sess-1' }
  })
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

const EXISTING_LAUNCH = { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-7' } }
const CREATE_LAUNCH = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
}
const AGENT_DISABLED = 'Selected agent is disabled. Choose an enabled agent before creating.'

/** The create throws; `afterDispatch` says whether the spawn request had already left. */
function failingCreate(runtime: AgentLaunchRuntimeStub, error: Error, afterDispatch: boolean) {
  runtime.createTerminal.mockImplementation(
    async (_selector: string, options?: Record<string, unknown>) => {
      const dispatched = options?.onPtySpawnDispatched
      if (afterDispatch && typeof dispatched === 'function') {
        dispatched()
      }
      throw error
    }
  )
}

describe('a launch whose terminal fails', () => {
  // The ledger admits against `Date.now()`, so the id must be dated now.
  const OPERATION_ID = `${Date.now()}-000000000000000000000000000000cc`
  let directory: string
  let store: AgentSessionRecordStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-prestart-'))
    store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `deps.store` is the only member `agent.launch` reads, and a member it omits throws on call.
    setStructuredAgentSessionHost({ deps: { store } } as unknown as StructuredAgentSessionHost)
  })

  afterEach(async () => {
    setStructuredAgentSessionHost(null)
    await rm(directory, { recursive: true, force: true })
  })

  function outcomeOf(operationId: string) {
    return store.listOperationRows().find((row) => row.operationId === operationId)?.outcome
  }

  async function replay(runtime: AgentLaunchRuntimeStub, launch: object) {
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method reached by agent.launch and dispatcher metadata.
      runtime: { ...runtime, getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService,
      methods: AGENT_LAUNCH_METHODS
    })
    return dispatcher.dispatch({
      id: 'request-1',
      authToken: 'token',
      method: 'agent.launchReplay',
      params: AGENT_LAUNCH_REPLAY.params.parse({ ...launch, operationId: OPERATION_ID })
    })
  }

  it('reports a failure before the spawn request with its real cause and records it', async () => {
    const runtime = runtimeStub({ settings: {} })
    failingCreate(runtime, new Error(AGENT_DISABLED), false)

    const response = await replay(runtime, EXISTING_LAUNCH)

    expect(response).toMatchObject({ ok: false, error: { message: AGENT_DISABLED } })
    expect(outcomeOf(OPERATION_ID)).toMatchObject({ status: 'failed', code: AGENT_DISABLED })
  })

  it('keeps a stable runtime code such as runtime_unavailable', async () => {
    const runtime = runtimeStub({ settings: {} })
    failingCreate(runtime, new Error('runtime_unavailable'), false)

    const response = await replay(runtime, EXISTING_LAUNCH)

    expect(response).toMatchObject({ ok: false, error: { code: 'runtime_unavailable' } })
  })

  it('answers a retry of the same operation from the record instead of launching again', async () => {
    const first = runtimeStub({ settings: {} })
    failingCreate(first, new Error(AGENT_DISABLED), false)
    await replay(first, EXISTING_LAUNCH)

    const retry = runtimeStub({ settings: {} })
    const response = await replay(retry, EXISTING_LAUNCH)

    expect(retry.createTerminal).not.toHaveBeenCalled()
    expect(response).toMatchObject({ ok: false, error: { message: AGENT_DISABLED } })
  })

  it('stays unknown when the failure came after the spawn request left', async () => {
    // An SSH or daemon spawn whose reply was lost may still have started an agent.
    const runtime = runtimeStub({ settings: {} })
    failingCreate(runtime, new Error('ssh_channel_closed'), true)

    const response = await replay(runtime, EXISTING_LAUNCH)

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent_session_operation_unknown' }
    })
    expect(outcomeOf(OPERATION_ID)?.status).toBe('unknown')
  })

  it('stays unknown for a launch that created its workspace first', async () => {
    const runtime = runtimeStub({ settings: {} })
    // No startup terminal came back, so the launch builds its own in the new workspace.
    runtime.createManagedWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-new' },
      startupTerminal: undefined
    })
    failingCreate(runtime, new Error(AGENT_DISABLED), false)

    const response = await replay(runtime, CREATE_LAUNCH)

    expect(runtime.createTerminal).toHaveBeenCalledTimes(1)
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent_session_operation_unknown' }
    })
  })
})
