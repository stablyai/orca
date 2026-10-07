/**
 * A create-worktree launch whose host stopped mid-create, against the real durable ledger.
 *
 * Before `git worktree add` the launch records the path and branch it is about to add and the
 * instance id the create writes into that worktree's metadata. A replay of the row it left `unknown`
 * stays uncertain about the agent, always: to a caller that reads it, it also names the workspace,
 * but only one whose metadata carries that instance id. A foreign worktree at the same path, or none
 * at all, names nothing, and no caller that does not read it sees any change.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_WORKSPACE_KEPT_CLIENT_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import type { AgentSessionOperationCreateIntent } from '../../../../shared/agent-session-operation-create-record'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import type { RpcContext } from '../core'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

// The ledger admits against `Date.now()`, so the id must be dated now.
const OPERATION_ID = `${Date.now()}-000000000000000000000000000000c1`
const WORKTREE_PATH = '/worktrees/task'
const INSTANCE_ID = 'instance-of-this-create'
const CREATE_LAUNCH = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } },
  operationId: OPERATION_ID
}
const PHONE_THAT_READS_IT: Partial<RpcContext> = {
  clientKind: 'mobile',
  pairedDeviceId: 'device-1',
  clientCapabilities: [
    AGENT_LAUNCH_RUNTIME_CAPABILITY,
    AGENT_LAUNCH_WORKSPACE_KEPT_CLIENT_CAPABILITY
  ]
}
const OLDER_PHONE: Partial<RpcContext> = {
  clientKind: 'mobile',
  pairedDeviceId: 'device-1',
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
}

let directory: string
let store: AgentSessionRecordStore

function launch(runtime: AgentLaunchRuntimeStub, context: Partial<RpcContext>): Promise<unknown> {
  return AGENT_LAUNCH_REPLAY.handler(
    AGENT_LAUNCH_REPLAY.params.parse(CREATE_LAUNCH),
    rpcContext(runtime, context)
  )
}

/** A host that dies inside the create, after it recorded what it was about to add. */
async function launchThatStopsMidCreate(context: Partial<RpcContext>): Promise<void> {
  const runtime = runtimeStub({ settings: {} })
  let stopped: () => void = () => {}
  const stoppedHere = new Promise<void>((resolve) => {
    stopped = resolve
  })
  runtime.createManagedWorktree.mockImplementationOnce(
    async (args: {
      onCreateCandidate?: (
        candidate: Omit<AgentSessionOperationCreateIntent, 'repoId'>
      ) => Promise<void>
    }) => {
      await args.onCreateCandidate?.({
        worktreePath: WORKTREE_PATH,
        branchName: 'task',
        instanceId: INSTANCE_ID
      })
      stopped()
      return new Promise(() => {})
    }
  )
  void launch(runtime, context)
  await stoppedHere
}

type Listed = { id: string; path: string; branch: string; instanceId?: string }

/** A new process: the store reread from disk, nothing in flight, and the repo's worktrees as listed. */
async function restartedHost(
  listing: Listed[] | Error
): Promise<AgentLaunchRuntimeStub & { listDetectedManagedWorktrees: ReturnType<typeof vi.fn> }> {
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
  return Object.assign(runtimeStub({ settings: {} }), {
    listDetectedManagedWorktrees: vi.fn(async (selector: string) => {
      if (listing instanceof Error) {
        throw listing
      }
      expect(selector).toBe('id:repo-1')
      return { repoId: 'repo-1', authoritative: true, worktrees: listing }
    })
  })
}

function rowOutcome() {
  return store.listOperationRows().find((row) => row.operationId === OPERATION_ID)?.outcome
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-create-reconcile-'))
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
})

afterEach(async () => {
  setAgentLaunchRecordStore(null)
  await rm(directory, { recursive: true, force: true })
})

describe('a create-worktree launch whose host stopped mid-create', () => {
  it('names the workspace it made, as the listing spells it, and stays uncertain about the agent', async () => {
    await launchThatStopsMidCreate(PHONE_THAT_READS_IT)

    // Git spelled the created path differently, so the create's own branch match finds it.
    const runtime = await restartedHost([
      {
        id: 'repo-1::/private/worktrees/task',
        path: '/private/worktrees/task',
        branch: 'refs/heads/task',
        instanceId: INSTANCE_ID
      }
    ])
    await expect(launch(runtime, PHONE_THAT_READS_IT)).rejects.toMatchObject({
      code: 'agent_session_operation_unknown',
      data: { worktreeId: 'repo-1::/private/worktrees/task' }
    })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    // Derived, never written: the row keeps its uncertain outcome for every later replay.
    expect(rowOutcome()).toEqual({ status: 'unknown' })
  })

  it('gives a caller that does not read it exactly the uncertain answer it always got', async () => {
    await launchThatStopsMidCreate(OLDER_PHONE)

    const runtime = await restartedHost([
      {
        id: `repo-1::${WORKTREE_PATH}`,
        path: WORKTREE_PATH,
        branch: 'refs/heads/task',
        instanceId: INSTANCE_ID
      }
    ])
    const error = await launch(runtime, OLDER_PHONE).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'agent_session_operation_unknown' })
    expect(error).not.toHaveProperty('data')
    expect(runtime.listDetectedManagedWorktrees).not.toHaveBeenCalled()
  })

  it("names nothing when the worktree at that path is another create's", async () => {
    await launchThatStopsMidCreate(PHONE_THAT_READS_IT)

    const runtime = await restartedHost([
      {
        id: `repo-1::${WORKTREE_PATH}`,
        path: WORKTREE_PATH,
        branch: 'refs/heads/task',
        instanceId: 'someone-else'
      }
    ])
    const error = await launch(runtime, PHONE_THAT_READS_IT).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'agent_session_operation_unknown' })
    expect(error).not.toHaveProperty('data')
  })

  it.each([
    [
      'a worktree with no metadata',
      [{ id: `repo-1::${WORKTREE_PATH}`, path: WORKTREE_PATH, branch: 'refs/heads/task' }]
    ],
    ['no worktree at all', []],
    ['a listing that fails', new Error('git worktree list failed')]
  ])('names nothing for %s', async (_label, listing) => {
    await launchThatStopsMidCreate(PHONE_THAT_READS_IT)

    const runtime = await restartedHost(listing)
    const error = await launch(runtime, PHONE_THAT_READS_IT).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'agent_session_operation_unknown' })
    expect(error).not.toHaveProperty('data')
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  })
})
