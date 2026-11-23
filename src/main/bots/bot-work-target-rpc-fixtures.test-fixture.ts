import { expect, vi } from 'vitest'
import { BotSchema, type Bot } from '../../shared/bot-types'
import { formatOrcaSessionAddress } from '../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address-test-fixture'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { claudeProviderHandle } from '../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import type { ResolvedBotWorkTargetPlacement } from '../../shared/agent-session/work-target/agent-session-work-target'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/orchestration/orchestration-runtime-capabilities'
import { removeTempDirs } from '../../shared/testing/remove-temp-dirs.test-support'
import { createWorktreeIdentity } from '../../shared/worktree/identity'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { closeTestStores } from '../persistence/persistence-test-harness'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { RpcRequest, RpcResponse } from '../runtime/rpc/core'
import type { ResolvedWorktree } from '../runtime/workspaces/catalog/runtime-worktree-path-identity'

export const BOT_SESSION_ID = testOrcaSessionId('9a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a01')
export const BOT_ADDRESS = formatOrcaSessionAddress(BOT_SESSION_ID)
export const STANDALONE_OTHER_SESSION_ID = testOrcaSessionId('9a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a99')

export type SyntheticWorktreeState = {
  id: string
  repoId: string
  path: string
  displayName: string
  branch: string
  instanceId: string
  isArchived?: boolean
  hostId?: 'local' | `ssh:${string}`
}

let reqCounter = 0

export function nextRequestId(prefix = 'req_followup'): string {
  reqCounter += 1
  return `${prefix}_${reqCounter}`
}

export function rpcReq(
  method: string,
  params: Record<string, unknown>,
  options: { sessionId?: string; requestId?: string; extra?: Partial<RpcRequest> } = {}
): RpcRequest {
  const requestId = options.requestId ?? nextRequestId()
  return {
    id: nextRequestId('rpc'),
    authToken: 'test-token',
    method,
    params,
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: requestId,
    compatibilityInvocationId: requestId,
    ...(options.sessionId
      ? { orchestrationCompatibilityEvidence: { agentSessionId: options.sessionId } }
      : {}),
    ...options.extra
  }
}

export function expectRpcFailure(
  response: RpcResponse,
  expectedCode: string
): { code: string; message: string; data?: unknown } {
  expect(response.ok).toBe(false)
  if (response.ok) {
    throw new Error('Expected RPC failure')
  }
  expect(response.error.code).toBe(expectedCode)
  if (expectedCode !== 'invalid_argument') {
    expect(response.error.data).toMatchObject({ effectsApplied: false })
  } else {
    expect(response.error.message).toMatch(/No effects were applied\.|Nothing was sent\./)
  }
  return response.error
}

export function makeFixtureBot(id: string, folderWorkspaceId: string, chatSessionId: string): Bot {
  return BotSchema.parse({
    id,
    name: 'HelperBot',
    hostId: 'local',
    folder: 'helper-bot',
    folderWorkspaceId,
    agent: 'codex',
    avatar: null,
    paused: false,
    notifications: { needsPermission: false, taskComplete: false, couldNotFinish: false },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId,
    createdAt: 1,
    updatedAt: 1
  })
}

export function makeFixtureSessionRecord(
  sessionId: string,
  workspaceId: string
): AgentSessionRecord {
  const base = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId, runtimeKind: 'native' })
  )
  return {
    ...base,
    location: { ...base.location, workspaceId },
    providerHandleChain: base.providerHandleChain.map((link) => ({
      ...link,
      handle: claudeProviderHandle(`provider-${sessionId}`, null)
    }))
  }
}

export function installStructuredSessionHost(
  hostRef: { current: unknown },
  records: Map<string, AgentSessionRecord>
): void {
  hostRef.current = {
    publishBackgroundTasks: () => {},
    subscribeStatus: () => () => {},
    usageLimitContinue: { onDispositionChange: () => () => {} },
    holdMailSources: async (attempts: unknown[]) => ({
      observations: attempts.map((attempt) => ({
        attempt,
        observation: {
          epoch: '',
          state: { kind: 'unreadable' as const },
          body: null,
          withdrawal: 'unknown' as const
        }
      })),
      current: () => true,
      release: () => {}
    }),
    observeConversationPublications: () => () => {},
    deps: {
      store: {
        getRecord: (sessionId: string) => records.get(sessionId) ?? null,
        getConversation: (id: string) => {
          const record = records.get(id)
          return record ? agentSessionConversationView(record) : null
        },
        listConversations: () => [...records.values()].map(agentSessionConversationView),
        requireWritableRecord: (id: string) => {
          const record = records.get(id)
          if (!record) {
            throw new Error(`Missing session record ${id}`)
          }
          return record
        },
        listRecords: () => [...records.values()],
        getVisibleSessionTabIndex: () => ({ present: false, sessionIds: [] }),
        connectorReplies: () => null
      }
    }
  }
}

export function makeWorkspaceSummary(entry: SyntheticWorktreeState): ResolvedWorktree {
  const hostId = entry.hostId ?? 'local'
  const git: GitWorktreeInfo = {
    path: entry.path,
    head: 'HEAD',
    branch: entry.branch,
    isBare: false,
    isMainWorktree: false
  }
  return {
    ...git,
    git,
    id: entry.id,
    repoId: entry.repoId,
    displayName: entry.displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: Boolean(entry.isArchived),
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    instanceId: entry.instanceId,
    hostId,
    identity: createWorktreeIdentity({
      worktreeId: entry.id,
      executionHostId: hostId,
      instanceId: entry.instanceId
    })
  }
}

export function makeExplicitWorkspaceTarget(
  overrides: Partial<ResolvedBotWorkTargetPlacement> = {}
): ResolvedBotWorkTargetPlacement {
  return {
    mode: 'existing',
    worktreeSelector: 'identity:wt2:local:inst-acme-1',
    targetHostId: 'local',
    expectedWorkspaceInstanceId: 'inst-acme-1',
    canonicalTarget: {
      kind: 'workspace',
      hostId: 'local',
      projectId: 'proj-acme',
      repoId: 'repo-acme',
      repoKind: 'git',
      workspaceId: 'wt-acme',
      workspaceInstanceId: 'inst-acme-1',
      workspaceKind: 'git-worktree',
      displayName: 'feat/auth-fix',
      projectName: 'acme-api'
    },
    ...overrides
  }
}

export function makeProjectTarget(
  overrides: Partial<ResolvedBotWorkTargetPlacement> = {}
): ResolvedBotWorkTargetPlacement {
  return {
    mode: 'new-top-level',
    repoSelector: 'id:repo-acme',
    targetHostId: 'local',
    canonicalTarget: {
      kind: 'project',
      hostId: 'local',
      projectId: 'proj-acme',
      repoId: 'repo-acme',
      repoKind: 'git',
      displayName: 'acme-api'
    },
    ...overrides
  }
}

export async function teardownFollowUpTestFixtures(
  hostRef: { current: unknown },
  dbs: OrchestrationDb[],
  tempDirs: string[]
): Promise<void> {
  vi.restoreAllMocks()
  hostRef.current = null
  for (const db of dbs.splice(0)) {
    try {
      db.close()
    } catch {
      // Already closed in restart tests.
    }
  }
  await closeTestStores()
  await removeTempDirs(tempDirs.splice(0))
}
