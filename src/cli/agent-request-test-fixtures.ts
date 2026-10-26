import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { RuntimeRpcSuccess } from './runtime-client'
import type { AgentRequestClient } from './agent-request-inventory'
import { AGENT_REQUEST_CLI_CAPABILITIES } from './agent-request-capabilities'
import { RUNTIME_SOURCE_FENCE_RUNTIME_CAPABILITY } from '../shared/host-runtime-capabilities'

export const REQUEST_SESSION = 'chat_session_01'
export const REQUEST_WORKSPACE = 'repo-id::C:/projects/example'
export const REQUEST_RUNTIME = 'runtime-test'
export const REQUEST_SOURCE = 'installation-test'
export const REQUEST_MARKER = {
  contract: 'agent-session.current-requests.v1' as const,
  sessionId: REQUEST_SESSION,
  epoch: 'epoch-test',
  publisher: '11111111-1111-4111-8111-111111111111',
  revision: 1,
  owner: 'publisher:current-owner',
  version: '22222222-2222-4222-8222-222222222222'
}
export const REQUEST_PROMPT = {
  itemId: 'provider:prompt-1',
  revision: 1,
  sequence: 1,
  observedAt: 100,
  turnScope: { kind: 'turn' as const, turnItemId: 'provider:turn-1' },
  body: {
    kind: 'approval' as const,
    title: 'Inspect one command',
    detail: 'Literal prompt data',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'deny', label: 'Deny' }
    ],
    resolution: {
      state: 'pending' as const,
      selectedOptionId: null,
      resolvedBy: null,
      resolvedAt: null
    }
  }
}
/** Supplies one inspected approval identity so tests vary scope without inventing live requests. */
export function answerFile() {
  return {
    workspaceId: REQUEST_WORKSPACE,
    sessionId: REQUEST_SESSION,
    expectedRuntimeId: REQUEST_RUNTIME,
    expectedRequests: REQUEST_MARKER,
    itemId: REQUEST_PROMPT.itemId,
    kind: 'approval' as const,
    expectedRuntimeFence: 7,
    expectedRevision: 1,
    clientOperationId: '33333333-3333-4333-8333-333333333333',
    optionId: 'approve'
  }
}

/** Gives byte-level file tests one temporary file and removes it even when their assertions fail. */
export async function withAnswerBytes<T>(
  bytes: Uint8Array,
  run: (path: string) => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-answer-utf8-'))
  const path = join(directory, 'answer.json')
  try {
    await writeFile(path, bytes)
    return await run(path)
  } finally {
    await rm(path, { force: true })
    await rmdir(directory)
  }
}

/** Provides deterministic read/receipt responses; overrides simulate races without a live runtime. */
export function requestFixtureClient(
  override?: (method: string, params: unknown, options: unknown) => unknown
) {
  const call = vi.fn(async (method: string, params: unknown, options: unknown) => {
    const supplied = override?.(method, params, options)
    if (supplied !== undefined) {
      return supplied
    }
    let result: unknown
    if (method === 'status.get') {
      result = {
        runtimeId: REQUEST_RUNTIME,
        capabilities: [...AGENT_REQUEST_CLI_CAPABILITIES, RUNTIME_SOURCE_FENCE_RUNTIME_CAPABILITY],
        hostDescriptor: { installationId: REQUEST_SOURCE }
      }
    } else if (method === 'session.tabs.list') {
      result = {
        worktree: REQUEST_WORKSPACE,
        tabs: [{ type: 'agent-session', id: 'tab-1', sessionId: REQUEST_SESSION, agent: 'codex' }]
      }
    } else if (method === 'agentSession.history') {
      result = {
        ok: true,
        page: { sessionId: REQUEST_SESSION, epoch: REQUEST_MARKER.epoch, fence: 7 }
      }
    } else if (method === 'agentSession.currentRequests') {
      const json = JSON.stringify([REQUEST_PROMPT])
      const version =
        typeof params === 'object' && params !== null && 'version' in params ? params.version : null
      result =
        version === REQUEST_MARKER.version
          ? { marker: REQUEST_MARKER, json, nextCursor: null }
          : { marker: REQUEST_MARKER, json: '', nextCursor: 0, restart: true }
    } else if (
      method === 'agentSession.respondToApproval' ||
      method === 'agentSession.respondToQuestion'
    ) {
      result = {
        ok: true,
        replayed: false,
        fence: 7,
        cursor: { epoch: REQUEST_MARKER.epoch, sequence: 2 },
        value: {
          itemId: REQUEST_PROMPT.itemId,
          revision: 2,
          resolution: {
            state: 'resolved',
            selectedOptionId: 'approve',
            resolvedBy: 'caller',
            resolvedAt: 100
          }
        }
      }
    } else {
      throw new Error(`Unexpected fake RPC: ${method}`)
    }
    return { id: 'test-request', ok: true, _meta: { runtimeId: REQUEST_RUNTIME }, result }
  })
  const client: AgentRequestClient = {
    /** Adapts fixture replies to the generic client API while recording each attempted RPC. */
    async call<T>(
      method: string,
      params?: unknown,
      options?: Parameters<AgentRequestClient['call']>[2]
    ) {
      // SAFETY: this test-only adapter stamps the fixture value for the generic RPC interface under test.
      return (await call(method, params, options)) as RuntimeRpcSuccess<T>
    }
  }
  return { client, call }
}
