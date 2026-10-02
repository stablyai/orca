import { vi } from 'vitest'
import type { AgentSessionLease, AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { structuredWorkerIdentities } from '../structured-worker-identity'
import type { RpcRequest, RpcResponse } from './core'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'

export const SESSION_X = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
export const SESSION_Y = testOrcaSessionId('7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64')
export const ADDRESS_X = formatOrcaSessionAddress(SESSION_X)
export const ADDRESS_Y = formatOrcaSessionAddress(SESSION_Y)
export const PROVIDER_ID_X = 'c0ffee11-2233-4455-8677-8899aabbccdd'
export const WORKSPACE_X = 'repo_1::/work/tree-x'
export const WORKER_HANDLE = 'term_worker'
export const WORKER_PANE = 'tab_worker:77777777-7777-4777-8777-777777777777'

export type SessionHostRef = { current: unknown }

/** A live chat session record; the lease and location can be pushed into any state. */
export function sessionRecord(
  sessionId: string,
  overrides: {
    lease?: Partial<AgentSessionLease>
    location?: Partial<AgentSessionRecord['location']>
    providerId?: string
  } = {}
): AgentSessionRecord {
  const base = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId, runtimeKind: 'native', ...overrides.lease })
  )
  return {
    ...base,
    location: { ...base.location, workspaceId: WORKSPACE_X, ...overrides.location },
    providerHandleChain: base.providerHandleChain.map((link) => ({
      ...link,
      handle: {
        provider: 'claude' as const,
        sessionId: overrides.providerId ?? `provider-${sessionId}`,
        leafUuid: null
      }
    }))
  }
}

export type SessionCallerHarness = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatcher: RpcDispatcher
  records: Map<string, AgentSessionRecord>
  /** Unary socket route: what the local CLI's Unix socket and Electron IPC reach. */
  dispatch: (request: RpcRequest) => Promise<RpcResponse>
  /** Streaming dispatcher, optionally as a paired client on another host. */
  dispatchStreaming: (request: RpcRequest, pairedDeviceId?: string) => Promise<unknown>
  close: () => void
}

export function createSessionCallerHarness(hostRef: SessionHostRef): SessionCallerHarness {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === WORKER_HANDLE ? WORKER_PANE : null
  )
  vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
    runtime.getTerminalPaneKey(handle)
  )
  const records = new Map<string, AgentSessionRecord>([
    [SESSION_X, sessionRecord(SESSION_X, { providerId: PROVIDER_ID_X })],
    [SESSION_Y, sessionRecord(SESSION_Y)]
  ])
  hostRef.current = {
    deps: {
      store: {
        getRecord: (sessionId: string) => records.get(sessionId) ?? null,
        listRecords: () => [...records.values()]
      }
    }
  }
  structuredWorkerIdentities.clear()
  const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
  return {
    runtime,
    db,
    dispatcher,
    records,
    dispatch: (request) => dispatcher.dispatch(request),
    dispatchStreaming: async (request, pairedDeviceId) => {
      const replies: string[] = []
      await dispatcher.dispatchStreaming(
        request,
        (reply) => replies.push(reply),
        pairedDeviceId ? { pairedDeviceId } : {}
      )
      const [reply] = replies
      if (replies.length !== 1 || reply === undefined) {
        throw new Error(`expected exactly one reply, got ${replies.length}`)
      }
      const parsed: unknown = JSON.parse(reply)
      return parsed
    },
    close: () => {
      hostRef.current = null
      structuredWorkerIdentities.clear()
      db.close()
    }
  }
}

let requestCounter = 0

/** An orchestration request as the CLI sends it, naming its caller by session id when given. */
export function orchestrationRequest(
  method: string,
  params: Record<string, unknown>,
  options: {
    sessionId?: string
    requestId?: string
    evidence?: OrchestrationCompatibilityEvidence
  } = {}
): RpcRequest {
  requestCounter += 1
  const requestId = options.requestId ?? `req-${requestCounter}`
  const evidence =
    options.sessionId === undefined
      ? options.evidence
      : { ...options.evidence, agentSessionId: options.sessionId }
  return {
    id: `rpc-${requestCounter}`,
    authToken: 'test',
    method,
    params,
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: requestId,
    compatibilityInvocationId: requestId,
    ...(evidence ? { orchestrationCompatibilityEvidence: evidence } : {})
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function resultOf(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.result)) {
    throw new Error(`expected a successful response, got ${JSON.stringify(response)}`)
  }
  return response.result
}

/** The `id` of a row a receipt carries. */
export function idOf(row: unknown): string {
  if (!isRecord(row) || typeof row.id !== 'string') {
    throw new Error(`expected a row with an id, got ${JSON.stringify(row)}`)
  }
  return row.id
}
