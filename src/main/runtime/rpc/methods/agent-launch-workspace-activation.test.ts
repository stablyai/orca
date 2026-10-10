/**
 * A desktop `agent.launch` create names itself on the activation that opens its workspace, so the
 * window that asked binds the workspace to that launch. A phone's or the CLI's create never does:
 * a paired device's launch leaves the desktop window alone, and the CLI's window holds no launch.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import type { RpcContext } from '../core'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import {
  CAPABLE_CLIENT,
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore
} from './agent-launch.test-fixture'

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async () => ({
    ok: true,
    value: { sessionId: 'sess-1' }
  })
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

// The ledger admits against `Date.now()`, so the id must be dated now.
const OPERATION_ID = `${Date.now()}-000000000000000000000000000000a7`

let directory: string
let store: AgentSessionRecordStore

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-activation-'))
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
})

afterEach(async () => {
  setAgentLaunchRecordStore(null)
  await rm(directory, { recursive: true, force: true })
})

async function createArgsFor(context: Partial<RpcContext>, activate: boolean) {
  const runtime = runtimeStub()
  await AGENT_LAUNCH_REPLAY.handler(
    AGENT_LAUNCH_REPLAY.params.parse({
      agent: 'claude',
      target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task', activate } },
      operationId: OPERATION_ID
    }),
    rpcContext(runtime, context)
  )
  const [args] = runtime.createManagedWorktree.mock.calls[0] ?? []
  return args
}

describe('the activation of a workspace an agent.launch creates', () => {
  it('names the desktop’s own launch', async () => {
    const args = await createArgsFor({ caller: DESKTOP_RPC_CALLER }, true)
    expect(args?.launchActivation).toEqual({ operationId: OPERATION_ID })
  })

  it.each([
    ['a paired phone', CAPABLE_CLIENT],
    ['the CLI', {}]
  ] as const)('never names %s’s launch', async (_who, context) => {
    const args = await createArgsFor(context, true)
    expect(args).not.toHaveProperty('launchActivation')
  })

  it('names nothing for a create that does not open its workspace', async () => {
    const args = await createArgsFor({ caller: DESKTOP_RPC_CALLER }, false)
    expect(args).not.toHaveProperty('launchActivation')
  })
})
