import type { RpcRequest } from '../core'
import {
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'

export const STRUCTURED_CLIENT = {
  clientKind: 'runtime' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY
  ]
}
export const STRUCTURED_MOBILE_CLIENT = {
  clientKind: 'mobile' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY
  ]
}

export const SESSION = 'session-alpha'
export const FINGERPRINT = 'f'.repeat(64)
export const OPERATION = '1800000000000-00000000000000000000000000000001'

export function envelope(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    clientOperationId: OPERATION,
    expectedRuntimeFence: 1,
    payloadFingerprint: FINGERPRINT,
    ...overrides
  }
}

export function sendParams(overrides: Record<string, unknown> = {}) {
  return {
    envelope: envelope(),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    ...overrides
  }
}

export function attachParams(overrides: Record<string, unknown> = {}) {
  return {
    envelope: envelope({ expectedRuntimeFence: null }),
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    ...overrides
  }
}

export function request(method: string, params: unknown): RpcRequest {
  return { id: 'request-1', authToken: 'token', method, params }
}
