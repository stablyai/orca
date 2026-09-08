import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgeCapability,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}
const REQUEST_ID = 'R'.repeat(22)
const WORKSPACE_ID = 'workspace-1'
const OTHER_WORKSPACE_ID = 'workspace-2'

type CorrelationCase = {
  name: string
  capability: MobileWebBridgeCapability
  operation: string
  invoke: (client: MobileWebBridgeClient) => Promise<unknown>
  result: unknown
}

const CORRELATION_CASES: CorrelationCase[] = [
  {
    name: 'Source Control history request limit',
    capability: 'workspace',
    operation: 'hostRequest',
    invoke: (client) => client.sourceControlHistory({ workspaceId: WORKSPACE_ID, limit: 1 }),
    result: {
      items: [],
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit: 2
    }
  },
  {
    name: 'session snapshot workspace',
    capability: 'workspace',
    operation: 'hostRequest',
    invoke: (client) => client.sessionSnapshot({ workspaceId: WORKSPACE_ID }),
    result: sessionSnapshot({ workspaceId: OTHER_WORKSPACE_ID })
  },
  {
    name: 'session activation tab',
    capability: 'workspace',
    operation: 'hostRequest',
    invoke: (client) => client.sessionActivate({ workspaceId: WORKSPACE_ID, tabId: 'tab-1' }),
    result: sessionSnapshot({ activeTabId: 'tab-2', activeTabType: 'terminal' })
  },
  {
    name: 'closed session tab',
    capability: 'workspace',
    operation: 'hostRequest',
    invoke: (client) => client.sessionClose({ workspaceId: WORKSPACE_ID, tabId: 'tab-1' }),
    result: {
      workspaceId: WORKSPACE_ID,
      tabId: 'tab-2',
      outcome: 'closed',
      refusalReason: null
    }
  },
  {
    name: 'account reset scope',
    capability: 'account',
    operation: 'consumeResetCredit',
    invoke: (client) =>
      client.account.consumeResetCredit({
        expectedScope: resetScope({ accountId: 'account-1' })
      }),
    result: {
      outcome: 'nothingToReset',
      scope: resetScope({ accountId: 'account-2' }),
      snapshot: accountSnapshot(),
      attemptJournalRetained: false
    }
  }
]

describe('mobile web operation response correlation', () => {
  for (const testCase of CORRELATION_CASES) {
    it(`rejects a schema-valid mismatched ${testCase.name}`, async () => {
      const harness = createHarness(testCase.capability, testCase.operation)
      const request = testCase.invoke(harness.client)
      harness.client.receive(response(testCase.result))

      await expect(request).rejects.toMatchObject({
        code: 'invalid_message',
        retryable: false
      })
    })
  }
})

function createHarness(capability: MobileWebBridgeCapability, operation: string) {
  const messages: MobileWebBridgePageMessage[] = []
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants: [
      {
        capability,
        operation,
        limits: {
          maxRequestBytes: 192 * 1024,
          maxResponseBytes: 640 * 1024,
          maxConcurrent: 1,
          rateCapacity: 4,
          rateRefillPerSecond: 1
        }
      }
    ],
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => REQUEST_ID
  })
  return { client, messages }
}

function response(payload: unknown): MobileWebBridgeShellMessage {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'response',
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    requestId: REQUEST_ID,
    status: 'success',
    payload
  }
}

function sessionSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeTabId: null,
    activeTabType: null,
    tabs: [],
    truncated: false,
    ...overrides
  }
}

function resetScope(overrides: Record<string, unknown> = {}) {
  return {
    target: { runtime: 'host' as const, wslDistro: null },
    accountId: 'account-1',
    accountRevision: 1,
    offerRevision: 'v1:offer',
    ...overrides
  }
}

function accountSnapshot() {
  const target = { runtime: 'host' as const, wslDistro: null }
  return {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: null,
      codex: null,
      claudeTarget: target,
      codexTarget: target,
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  }
}
