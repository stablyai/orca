import '../unused-default-rpc-methods.test-fixture'
/**
 * A terminal launch that fails before its spawn is requested — no launch command, runtime
 * unavailable — created nothing, so a named operation settles as failed with its real cause.
 * Once the request has left, a failure proves nothing and the outcome stays unknown.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentLaunchFingerprint } from '../../../../shared/agent-launch-operation'
import { AGENT_LAUNCH_AGENT_NOT_STARTED_CODE } from '../../../../shared/agent-launch-agent-not-started'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { startRuntimeLocalWorktreeTerminals } from '../../runtime-local-worktree-terminal-startup'
import type { RuntimeManagedWorktreeCreateArgs } from '../../runtime-managed-worktree-create-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  methodNamed,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

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
const NO_LAUNCH_COMMAND = 'Could not build launch command for claude.'
type Launch = {
  agent: string
  target: { kind: string; worktree?: string; create?: Readonly<Record<string, unknown>> }
  sessionOptions?: Readonly<Record<string, unknown>>
  reuseTerminal?: { handle: string }
}

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
  // The ledger admits against `Date.now()`, so the ids must be dated now.
  const OPERATION_ID = `${Date.now()}-000000000000000000000000000000cc`
  const OTHER_OPERATION_ID = `${Date.now()}-000000000000000000000000000000dd`
  let directory: string
  let store: AgentSessionRecordStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-prestart-'))
    store = await openTestAgentSessionRecordStore(directory)
    setAgentLaunchRecordStore(store)
  })

  afterEach(async () => {
    setAgentLaunchRecordStore(null)
    await rm(directory, { recursive: true, force: true })
  })

  function outcomeOf(operationId: string) {
    return store.listOperationRows().find((row) => row.operationId === operationId)?.outcome
  }

  async function replay(
    runtime: AgentLaunchRuntimeStub,
    launch: Launch,
    operationId: string = OPERATION_ID,
    caller?: Parameters<RpcDispatcher['dispatch']>[1]
  ) {
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method reached by agent.launch and dispatcher metadata.
      runtime: { ...runtime, getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService,
      methods: AGENT_LAUNCH_METHODS
    })
    return dispatcher.dispatch(
      {
        id: 'request-1',
        authToken: 'token',
        method: 'agent.launchReplay',
        params: AGENT_LAUNCH_REPLAY.params.parse({ ...launch, operationId })
      },
      caller
    )
  }

  it('reports a failure before the spawn request with its real cause and records it', async () => {
    const runtime = runtimeStub({ settings: {} })
    failingCreate(runtime, new Error(NO_LAUNCH_COMMAND), false)

    const response = await replay(runtime, EXISTING_LAUNCH)

    expect(response).toMatchObject({ ok: false, error: { message: NO_LAUNCH_COMMAND } })
    expect(outcomeOf(OPERATION_ID)).toMatchObject({ status: 'failed', code: NO_LAUNCH_COMMAND })
  })

  it('keeps a stable runtime code such as runtime_unavailable', async () => {
    const runtime = runtimeStub({ settings: {} })
    failingCreate(runtime, new Error('runtime_unavailable'), false)

    const response = await replay(runtime, EXISTING_LAUNCH)

    expect(response).toMatchObject({ ok: false, error: { code: 'runtime_unavailable' } })
  })

  it('answers a retry of the same operation from the record instead of launching again', async () => {
    const first = runtimeStub({ settings: {} })
    failingCreate(first, new Error(NO_LAUNCH_COMMAND), false)
    await replay(first, EXISTING_LAUNCH)

    const retry = runtimeStub({ settings: {} })
    const response = await replay(retry, EXISTING_LAUNCH)

    expect(retry.createTerminal).not.toHaveBeenCalled()
    expect(response).toMatchObject({ ok: false, error: { message: NO_LAUNCH_COMMAND } })
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

  it('stays unknown when another launch saw the same error before its own spawn request', async () => {
    // A failed pane spawn rejects one error into the spawner and into a create waiting on that pane.
    const shared = new Error('ssh_channel_closed')
    const waiting = runtimeStub({ settings: {} })
    failingCreate(waiting, shared, false)
    await replay(waiting, EXISTING_LAUNCH, OTHER_OPERATION_ID)
    expect(outcomeOf(OTHER_OPERATION_ID)?.status).toBe('failed')

    const spawner = runtimeStub({ settings: {} })
    failingCreate(spawner, shared, true)
    const response = await replay(spawner, EXISTING_LAUNCH)

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent_session_operation_unknown' }
    })
    expect(outcomeOf(OPERATION_ID)?.status).toBe('unknown')
  })

  // Every caller and method: agent-launch-workspace-kept.test.ts.
  it('names the kept workspace when no agent was asked for, and answers a retry from the record', async () => {
    const local = runtimeStub({ settings: {} })
    // No startup terminal came back, so the launch builds its own in the new workspace.
    local.createManagedWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-new' },
      startupTerminal: undefined
    })
    failingCreate(local, new Error(NO_LAUNCH_COMMAND), false)
    const response = await replay(local, CREATE_LAUNCH)
    expect(local.createTerminal).toHaveBeenCalledTimes(1)
    expect(response).toMatchObject({
      ok: false,
      error: { code: AGENT_LAUNCH_AGENT_NOT_STARTED_CODE, data: { worktreeId: 'wt-new' } }
    })
    expect(outcomeOf(OPERATION_ID)).toMatchObject({
      status: 'failed',
      code: 'agent_session_operation_unknown',
      keptWorktreeId: 'wt-new'
    })

    // The same id again answers from the one settle, without creating anything.
    const retry = runtimeStub({ settings: {} })
    expect(await replay(retry, CREATE_LAUNCH)).toMatchObject({
      ok: false,
      error: { code: AGENT_LAUNCH_AGENT_NOT_STARTED_CODE, data: { worktreeId: 'wt-new' } }
    })
    expect(retry.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('stays unknown for a created workspace whose terminal failed after its spawn left', async () => {
    const runtime = runtimeStub({ settings: {} })
    runtime.createManagedWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-new' },
      startupTerminal: undefined
    })
    failingCreate(runtime, new Error('reply lost'), true)

    expect(await replay(runtime, CREATE_LAUNCH)).toMatchObject({
      ok: false,
      error: { code: 'agent_session_operation_unknown' }
    })
    expect(outcomeOf(OPERATION_ID)?.status).toBe('unknown')
  })

  it('stays unknown when the create asked for its startup agent before its own terminal failed', async () => {
    // The real startup step runs on the stub's terminals: its spawn request leaves and the reply is
    // lost, so that agent may run. The launch's second terminal then fails before its request
    // leaves, which proves nothing about the first.
    const runtime = runtimeStub({ settings: {} })
    runtime.createManagedWorktree.mockImplementationOnce(async (args: Record<string, unknown>) => {
      const started = await startRuntimeLocalWorktreeTerminals({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch's own create args, as `createManagedWorktree` receives them.
        request: args as unknown as RuntimeManagedWorktreeCreateArgs,
        repo: { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: 'blue', addedAt: 1 },
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup step reads only the worktree's id and path.
        worktree: { id: 'wt-new', path: '/worktrees/task' } as Worktree,
        createdWithAgent: 'claude',
        startup: { command: 'claude' },
        ports: {
          canSpawn: true,
          createTerminal: async (selector, options) => ({
            ...(await runtime.createTerminal(selector, options)),
            worktreeId: 'wt-new',
            title: null
          }),
          pasteDraft: vi.fn(),
          sendFollowup: vi.fn(),
          provision: vi.fn(),
          activate: vi.fn()
        }
      })
      return { worktree: { id: 'wt-new' }, startupTerminal: undefined, warning: started.warning }
    })
    runtime.createTerminal
      .mockImplementationOnce(async (_selector: string, options?: Record<string, unknown>) => {
        const dispatched = options?.onPtySpawnDispatched
        if (typeof dispatched === 'function') {
          dispatched()
        }
        throw new Error('reply lost')
      })
      .mockImplementationOnce(async () => {
        throw new Error(NO_LAUNCH_COMMAND)
      })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await replay(runtime, CREATE_LAUNCH)
    warn.mockRestore()

    expect(runtime.createTerminal).toHaveBeenCalledTimes(2)
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent_session_operation_unknown' }
    })
    expect(outcomeOf(OPERATION_ID)?.status).toBe('unknown')
  })

  it.each([
    { ...CREATE_LAUNCH, agent: 'opencode', sessionOptions: { model: 'private-proof/model-b' } },
    {
      ...EXISTING_LAUNCH,
      agent: 'opencode',
      reuseTerminal: { handle: 'term_existing' },
      sessionOptions: { model: 'private-proof/model-b' }
    }
  ])('records and replays a model refusal before adapter effects', async (launch) => {
    const first = runtimeStub({ settings: {} })
    expect(await replay(first, launch)).toMatchObject({
      ok: false,
      error: { code: 'capability_unsupported' }
    })
    expect(outcomeOf(OPERATION_ID)).toMatchObject({
      status: 'failed',
      code: 'capability_unsupported'
    })
    expect(first.showRepo).not.toHaveBeenCalled()
    expect(first.createManagedWorktree).not.toHaveBeenCalled()
    expect(first.createTerminal).not.toHaveBeenCalled()
    const retry = runtimeStub({ settings: {} })
    expect(await replay(retry, launch)).toMatchObject({
      ok: false,
      error: { code: 'capability_unsupported' }
    })
    expect(retry.showTerminalWorkspaceLaunchScope).not.toHaveBeenCalled()
    expect(retry.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('preserves a successful recorded model launch even when its placement is now refused', async () => {
    const launch = AGENT_LAUNCH_REPLAY.params.parse({
      ...CREATE_LAUNCH,
      agent: 'opencode',
      sessionOptions: { model: 'private-proof/model-b' },
      operationId: OPERATION_ID
    })
    const callerKey = 'trusted-local:runtime'
    await store.admitOperation({
      callerKey,
      operationId: OPERATION_ID,
      fingerprint: computeAgentLaunchFingerprint(launch),
      now: Date.now()
    })
    await store.claimOperation({ callerKey, operationId: OPERATION_ID })
    await store.recordOperationOutcome({
      callerKey,
      operationId: OPERATION_ID,
      outcome: {
        status: 'succeeded',
        sessionId: '',
        launch: {
          outcome: { kind: 'terminal', handle: 'term_historical' },
          worktreeId: 'wt_historical',
          receipt: {
            mode: 'terminal',
            preferred: 'terminal',
            reason: 'user_default',
            detail: 'Previously recorded launch'
          }
        }
      }
    })
    const runtime = runtimeStub({ settings: {} })
    expect(await replay(runtime, launch)).toMatchObject({
      ok: true,
      result: { outcome: { handle: 'term_historical' }, worktreeId: 'wt_historical' }
    })
    expect(runtime.showRepo).not.toHaveBeenCalled()
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })
})
