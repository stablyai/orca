import { afterEach, beforeEach, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_SESSION as SESSION,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'
import type * as fileOperations from 'node:fs/promises'
import * as contextSnapshots from '../../../native-chat/agent-session-context-snapshots'

vi.mock('node:fs/promises', { spy: true })
export const actualFiles = await vi.importActual<typeof fileOperations>('node:fs/promises')

export const CLIENT = {
  clientId: 'device-1',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  connectionId: 'connection-1'
}

let rig: RestTestRig

let dispatcher: RpcDispatcher

let requests = 0

export async function call(
  method: string,
  params: unknown,
  client: RpcDispatchStreamingOptions = CLIENT
): Promise<RpcResponse[]> {
  const replies: RpcResponse[] = []
  requests += 1
  await dispatcher.dispatchStreaming(
    { id: `request-${requests}`, authToken: 'token', method, params },
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    client
  )
  return replies
}

/** A chat that once ran, reopened by a fresh host: nothing of it is in memory. */

export async function restingChat(): Promise<void> {
  await foundRestTestChat(rig)
  await rig.store.replaceSessionOptions({
    sessionId: SESSION,
    fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
    options: { model: 'gpt-saved', effort: 'high' },
    now: rig.clock.now
  })
  await rig.restart()
  setStructuredAgentSessionHost(rig.host)
  rig.adapter.acquire.mockClear()
  rig.adapter.dispatch.mockClear()
  rig.adapter.readOptions.mockClear()
}

beforeEach(async () => {
  requests = 0
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  setStructuredAgentSessionHost(rig.host)
  const runtime = new OrcaRuntimeService()
  dispatcher = new RpcDispatcher({ runtime, methods: STRUCTURED_AGENT_SESSION_METHODS })
})

afterEach(async () => {
  vi.restoreAllMocks()
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  await actualFiles.rm(contextSnapshots.agentSessionContextSnapshotRoot(rig.root), {
    recursive: true,
    force: true
  })
})

export const fixture = {
  get dispatcher() {
    return dispatcher
  },
  set dispatcher(value: typeof dispatcher) {
    dispatcher = value
  },
  get requests() {
    return requests
  },
  set requests(value: typeof requests) {
    requests = value
  },
  get rig() {
    return rig
  },
  set rig(value: typeof rig) {
    rig = value
  }
}
