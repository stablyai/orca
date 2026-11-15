import { closeTestJournalHostDatabases } from '../../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
/** Caller-reserved pane identity crosses the wire; placement stays client-owned, and the returned paneKey identifies the actual pane after replay or fallback. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecordStore } from '../../../agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../../agent-session/records/agent-session-record-store-test-harness'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcContext } from '../../core'
import { RpcDispatcher } from '../../dispatcher'
import '../../../orchestration/orchestration-error'
import {
  CAPABLE_CLIENT,
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStub as RuntimeStub
} from './agent-launch.test-fixture'

vi.mock('../structured-sessions/creation/structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async () => ({
    ok: true,
    value: { sessionId: 'sess-1' }
  })
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`

/** No structured preference, so every launch here settles as a terminal unless it says otherwise. */
const TERMINAL_ONLY = {}

const EXISTING_LAUNCH = { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-7' } }
const CREATE_LAUNCH = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
}

async function launch(params: unknown, runtime: RuntimeStub, context: Partial<RpcContext> = {}) {
  const parsed = AGENT_LAUNCH.params.safeParse(params)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  return AGENT_LAUNCH.handler(parsed.data, rpcContext(runtime, { ...CAPABLE_CLIENT, ...context }))
}

describe('a live-pane refusal under a named operation', () => {
  // The ledger admits against `Date.now()`, so the id must be dated now.
  const OPERATION_ID = `${Date.now()}-000000000000000000000000000000bb`
  let directory: string
  let store: AgentSessionRecordStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-pane-'))
    store = await openTestAgentSessionRecordStore(directory)
    setAgentLaunchRecordStore(store)
  })

  afterEach(async () => {
    setAgentLaunchRecordStore(null)
    await closeTestJournalHostDatabases()
    await rm(directory, { recursive: true, force: true })
  })

  function outcomeOf(operationId: string) {
    return store.listOperationRows().find((row) => row.operationId === operationId)?.outcome
  }

  async function dispatch(runtime: RuntimeStub, method: string, params: unknown) {
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method reached by agent.launch and dispatcher metadata.
      runtime: { ...runtime, getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService,
      methods: AGENT_LAUNCH_METHODS
    })
    return dispatcher.dispatch({ id: 'request-1', authToken: 'token', method, params })
  }

  it('records the refusal as a failure, so a retry is answered rather than left unknown', async () => {
    const params = { ...EXISTING_LAUNCH, paneKey: PANE_KEY, operationId: OPERATION_ID }
    await expect(
      launch(params, runtimeStub({ settings: TERMINAL_ONLY, terminalPaneAlreadyLive: true }))
    ).rejects.toThrow('agent_launch_pane_already_live')
    expect(outcomeOf(OPERATION_ID)).toMatchObject({
      status: 'failed',
      code: 'agent_launch_pane_already_live'
    })

    const retry = runtimeStub({ settings: TERMINAL_ONLY })
    await expect(launch(params, retry)).rejects.toThrow('agent_launch_pane_already_live')
    expect(retry.createTerminal).not.toHaveBeenCalled()
  })

  it('answers agent.launchReplay with the refusal code, not operation_unknown', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY, terminalPaneAlreadyLive: true })
    const params = AGENT_LAUNCH_REPLAY.params.parse({
      ...EXISTING_LAUNCH,
      paneKey: PANE_KEY,
      operationId: OPERATION_ID
    })

    const response = await dispatch(runtime, 'agent.launchReplay', params)

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent_launch_pane_already_live' }
    })
    expect(outcomeOf(OPERATION_ID)).toMatchObject({ status: 'failed' })
  })

  it('leaves a create-worktree launch unknown, because its workspace was already created', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY, terminalPaneAlreadyLive: true })
    // No startup terminal came back, so the launch builds its own in the new workspace.
    runtime.createManagedWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-new' },
      startupTerminal: undefined
    })
    const params = AGENT_LAUNCH_REPLAY.params.parse({
      ...CREATE_LAUNCH,
      paneKey: PANE_KEY,
      operationId: OPERATION_ID
    })

    const response = await dispatch(runtime, 'agent.launchReplay', params)

    expect(runtime.createTerminal).toHaveBeenNthCalledWith(
      1,
      'id:wt-new',
      expect.objectContaining({ startupAgent: 'claude' })
    )
    expect(runtime.createTerminal).toHaveBeenNthCalledWith(2, 'id:wt-new', {
      surfaceOwner: false
    })
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent_session_operation_unknown' }
    })
    expect(outcomeOf(OPERATION_ID)?.status).toBe('unknown')
    expect(await dispatch(runtime, 'agent.launchReplay', params)).toMatchObject(response)
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(runtime.createTerminal).toHaveBeenCalledTimes(2)
  })
})
