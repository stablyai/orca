import { closeTestJournalHostDatabases } from '../../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
/** Pre-dispatch failures prove no effects and record the real cause; a lost reply after dispatch remains unknown. Explicitly unsupported chat is refused before creation. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentLaunchFingerprint } from '../../../../../shared/agent-launch/contracts/agent-launch-operation'
import '../../../../../shared/agent-launch/contracts/agent-launch-surface'
import '../../../../opencode/model-launch/opencode-model-startup-plan'
import type { AgentSessionRecordStore } from '../../../agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../../agent-session/records/agent-session-record-store-test-harness'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import '../../../workspaces/lineage/runtime-worktree-lineage-resolution'
import '../../../../agent-launch/agent-launch-not-started'
import './agent-launch-failure-code'
import { RpcDispatcher } from '../../dispatcher'
import type { RpcDispatchStreamingOptions } from '../../dispatcher-stream-options'
import {
  methodNamed,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

vi.mock('../structured-sessions/creation/structured-agent-session-create', () => ({
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
  chatOptions?: Readonly<Record<string, string>>
  reuseTerminal?: { handle: string }
  cwd?: string
  surface?: string
  nativeChatDefault?: boolean
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
  const dispatchers = new WeakMap<AgentLaunchRuntimeStub, RpcDispatcher>()

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-prestart-'))
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

  async function replay(
    runtime: AgentLaunchRuntimeStub,
    launch: Launch,
    operationId: string = OPERATION_ID,
    options?: RpcDispatchStreamingOptions
  ) {
    let dispatcher = dispatchers.get(runtime)
    if (!dispatcher) {
      dispatcher = new RpcDispatcher({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method reached by agent.launch and dispatcher metadata.
        runtime: { ...runtime, getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService,
        methods: AGENT_LAUNCH_METHODS
      })
      dispatchers.set(runtime, dispatcher)
    }
    return dispatcher.dispatch(
      {
        id: 'request-1',
        authToken: 'token',
        method: 'agent.launchReplay',
        params: AGENT_LAUNCH_REPLAY.params.parse({ ...launch, operationId })
      },
      options
    )
  }

  it('reports a failure before the spawn request with its real cause and records it', async () => {
    const runtime = runtimeStub({ settings: {} })
    failingCreate(runtime, new Error(NO_LAUNCH_COMMAND), false)

    const response = await replay(runtime, EXISTING_LAUNCH)

    expect(response).toMatchObject({ ok: false, error: { message: NO_LAUNCH_COMMAND } })
    expect(outcomeOf(OPERATION_ID)).toMatchObject({ status: 'failed', code: NO_LAUNCH_COMMAND })
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
