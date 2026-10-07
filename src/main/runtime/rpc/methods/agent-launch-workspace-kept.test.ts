import '../unused-default-rpc-methods.test-fixture'
/**
 * A create-worktree launch that made its workspace and provably never started its agent, as each
 * caller hears it on each method, live and on a replay of the same id, against the real ledger.
 *
 * A caller that reads `agent.launch.workspace-kept.v1` (or the local socket, which declares no client)
 * gets `agent_launch_agent_not_started` naming the workspace. Any other caller gets exactly what it
 * got before the host knew: the uncertain answer on the replay-safe paths, the failure that stopped
 * the agent on `agent.launch`.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_LAUNCH_AGENT_NOT_STARTED_CODE } from '../../../../shared/agent-launch-agent-not-started'
import { computeAgentLaunchFingerprint } from '../../../../shared/agent-launch-operation'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_WORKSPACE_KEPT_CLIENT_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from '../../agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import type { RpcContext } from '../core'
import { mapRuntimeError } from '../errors'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore
} from './agent-launch.test-fixture'

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

const OPERATION_ID = `${Date.now()}-000000000000000000000000000000e1`
// Regular CI shards are shallow; opt in to the real historical reader where its source is present.
const ROLLBACK_ROOT = process.env.ORCA_AGENT_LAUNCH_ROLLBACK_ROOT?.trim()
const NO_LAUNCH_COMMAND = 'Could not build launch command for claude.'
const CREATE_LAUNCH = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
}
type Caller = Partial<RpcContext>

// No declared client: the local runtime socket and the SSH CLI bridge.
const LOCAL_SOCKET: Caller = {}
const PHONE_THAT_READS_IT: Caller = {
  clientKind: 'mobile',
  pairedDeviceId: 'device-1',
  clientCapabilities: [
    AGENT_LAUNCH_RUNTIME_CAPABILITY,
    AGENT_LAUNCH_WORKSPACE_KEPT_CLIENT_CAPABILITY
  ]
}
const OLDER_PHONE: Caller = {
  clientKind: 'mobile',
  pairedDeviceId: 'device-1',
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
}

const KEPT = {
  ok: false,
  error: { code: AGENT_LAUNCH_AGENT_NOT_STARTED_CODE, data: { worktreeId: 'wt-new' } }
}
const UNKNOWN = { ok: false, error: { code: 'agent_session_operation_unknown' } }
const ORIGINAL_FAILURE = { ok: false, error: { code: 'runtime_error', message: NO_LAUNCH_COMMAND } }

let directory: string
let store: AgentSessionRecordStore

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-workspace-kept-'))
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
})

afterEach(async () => {
  setAgentLaunchRecordStore(null)
  await rm(directory, { recursive: true, force: true })
})

/** The create makes `wt-new` and returns no startup terminal; the launch's own terminal then fails
 *  before its spawn request leaves, so no agent was ever asked for. */
function keepsWorkspace() {
  const runtime = runtimeStub({ settings: {} })
  runtime.createManagedWorktree.mockResolvedValue({
    worktree: { id: 'wt-new' },
    startupTerminal: undefined
  })
  runtime.createTerminal.mockImplementation(async () => {
    throw new Error(NO_LAUNCH_COMMAND)
  })
  return runtime
}

/** What the caller reads on the wire: the method's own failure, mapped as the transport maps it. */
async function call(
  runtime: ReturnType<typeof runtimeStub>,
  method: 'agent.launch' | 'agent.launchReplay',
  params: Record<string, unknown>,
  caller: Caller
) {
  const context = rpcContext(runtime, caller)
  try {
    await (method === 'agent.launch'
      ? AGENT_LAUNCH.handler(AGENT_LAUNCH.params.parse(params), context)
      : AGENT_LAUNCH_REPLAY.handler(AGENT_LAUNCH_REPLAY.params.parse(params), context))
  } catch (error) {
    return mapRuntimeError('request-1', { runtimeId: 'runtime-1' }, error)
  }
  throw new Error('the launch was expected to fail')
}

describe.each([
  { label: 'agent.launchReplay', method: 'agent.launchReplay' as const, otherwise: UNKNOWN },
  {
    label: 'agent.launch with an operation id',
    method: 'agent.launch' as const,
    otherwise: ORIGINAL_FAILURE
  }
])('$label', ({ method, otherwise }) => {
  const params = { ...CREATE_LAUNCH, operationId: OPERATION_ID }

  it.each([
    ['the local socket', LOCAL_SOCKET],
    ['a phone that reads it', PHONE_THAT_READS_IT]
  ])(
    'names the kept workspace to %s, live and on a replay of the same id',
    async (_label, caller) => {
      expect(await call(keepsWorkspace(), method, params, caller)).toMatchObject(KEPT)
      expect(store.listOperationRows()[0]?.outcome).toMatchObject({
        status: 'failed',
        code: 'agent_session_operation_unknown',
        keptWorktreeId: 'wt-new'
      })

      const retry = keepsWorkspace()
      expect(await call(retry, method, params, caller)).toMatchObject(KEPT)
      expect(retry.createManagedWorktree).not.toHaveBeenCalled()
    }
  )

  it('answers an older phone as it always did, live, and uncertain on a replay', async () => {
    const live = await call(keepsWorkspace(), method, params, OLDER_PHONE)
    expect(live).toMatchObject(otherwise)
    expect(live).not.toHaveProperty('error.data')
    expect(store.listOperationRows()[0]?.outcome).toEqual({
      status: 'failed',
      code: 'agent_session_operation_unknown',
      keptWorktreeId: 'wt-new'
    })

    const retry = keepsWorkspace()
    const replayed = await call(retry, method, params, OLDER_PHONE)
    expect(replayed).toMatchObject(UNKNOWN)
    expect(replayed).not.toHaveProperty('error.data')
    expect(retry.createManagedWorktree).not.toHaveBeenCalled()
  })
})

describe('stored workspace-kept enrichment', () => {
  const params = { ...CREATE_LAUNCH, operationId: OPERATION_ID }

  it.skipIf(!ROLLBACK_ROOT)(
    'remains unknown when the prior main host loads and replays the new row',
    async () => {
      if (!ROLLBACK_ROOT) {
        throw new Error('The rollback oracle requires an extracted historical host source')
      }
      await call(keepsWorkspace(), 'agent.launchReplay', params, OLDER_PHONE)
      const loadHistoricalHostModule = (path: string) =>
        import(/* @vite-ignore */ join(ROLLBACK_ROOT, path).split('\\').join('/'))
      const records = await loadHistoricalHostModule(
        'src/main/runtime/agent-session-record-store.ts'
      )
      const replay = await loadHistoricalHostModule(
        'src/main/runtime/rpc/methods/agent-launch-replay.ts'
      )
      const errors = await loadHistoricalHostModule('src/main/runtime/rpc/errors.ts')
      if (
        typeof records.AgentSessionRecordStore?.open !== 'function' ||
        typeof replay.admitAgentLaunchOperation !== 'function' ||
        typeof errors.mapRuntimeError !== 'function'
      ) {
        throw new Error(
          'The prior host must export its real row loader, launch reader and error mapper'
        )
      }
      const persisted = await readPersistedTestAgentSessionStore(directory)
      const legacyStore = records.AgentSessionRecordStore.open({
        journalDatabase: openTestJournalHostDatabase(directory),
        hostId: 'local'
      })
      expect(legacyStore.listOperationRows()).toEqual(Object.values(persisted.operations))
      const retry = keepsWorkspace()
      retry.openAgentSessionRecordStore.mockResolvedValue(legacyStore)
      const parsed = AGENT_LAUNCH_REPLAY.params.parse(params)
      const answer = await replay.admitAgentLaunchOperation(
        rpcContext(retry, OLDER_PHONE),
        parsed,
        computeAgentLaunchFingerprint(parsed)
      )
      expect(answer).toMatchObject({
        decision: 'refuse',
        refusal: { code: 'agent_session_operation_unknown' }
      })
      expect(answer).not.toHaveProperty('refusal.data')
      expect(
        errors.mapRuntimeError(
          'request-1',
          { runtimeId: 'runtime-1' },
          new Error(answer.refusal.code)
        )
      ).toMatchObject(UNKNOWN)
      expect(retry.createManagedWorktree).not.toHaveBeenCalled()
    },
    180_000
  )

  it.each(['agent_session_operation_unknown', AGENT_LAUNCH_AGENT_NOT_STARTED_CODE])(
    'reads a valid settled workspace identity beside %s',
    async (code) => {
      await call(keepsWorkspace(), 'agent.launchReplay', params, PHONE_THAT_READS_IT)
      await editPersistedTestAgentSessionStore(directory, (persisted) => {
        for (const row of Object.values(persisted.operations)) {
          row.outcome = { status: 'failed', code, keptWorktreeId: 'wt-new' }
        }
      })
      store = await openTestAgentSessionRecordStore(directory)
      setAgentLaunchRecordStore(store)
      expect(
        await call(keepsWorkspace(), 'agent.launchReplay', params, PHONE_THAT_READS_IT)
      ).toMatchObject(KEPT)
      const older = await call(keepsWorkspace(), 'agent.launchReplay', params, OLDER_PHONE)
      expect(older).toMatchObject(UNKNOWN)
      expect(older).not.toHaveProperty('error.data')
    }
  )

  it.each(['agent_session_operation_unknown', AGENT_LAUNCH_AGENT_NOT_STARTED_CODE])(
    'keeps %s rows replayable without a valid workspace identity',
    async (code) => {
      await call(keepsWorkspace(), 'agent.launchReplay', params, PHONE_THAT_READS_IT)
      for (const keptWorktreeId of [undefined, null, '', '  ', 42, true, {}, ['wt-new']]) {
        await editPersistedTestAgentSessionStore(directory, (persisted) => {
          for (const row of Object.values(persisted.operations)) {
            row.outcome = { status: 'failed', code, keptWorktreeId }
          }
        })
        store = await openTestAgentSessionRecordStore(directory)
        setAgentLaunchRecordStore(store)
        expect(store.listOperationRows()).toHaveLength(1)
        const retry = keepsWorkspace()
        for (const method of ['agent.launch', 'agent.launchReplay'] as const) {
          const response = await call(retry, method, params, PHONE_THAT_READS_IT)
          expect(response).toMatchObject(UNKNOWN)
          expect(response).not.toHaveProperty('error.data')
        }
        expect(retry.createManagedWorktree).not.toHaveBeenCalled()
      }
    }
  )
})

describe('agent.launch without an operation id', () => {
  it.each([
    ['the local socket', LOCAL_SOCKET],
    ['a phone that reads it', PHONE_THAT_READS_IT]
  ])('names the kept workspace to %s', async (_label, caller) => {
    expect(await call(keepsWorkspace(), 'agent.launch', CREATE_LAUNCH, caller)).toMatchObject(KEPT)
  })

  it('answers an older phone with the failure that stopped the agent, as before', async () => {
    const response = await call(keepsWorkspace(), 'agent.launch', CREATE_LAUNCH, OLDER_PHONE)
    expect(response).toMatchObject(ORIGINAL_FAILURE)
    expect(response).not.toHaveProperty('error.data')
  })
})
