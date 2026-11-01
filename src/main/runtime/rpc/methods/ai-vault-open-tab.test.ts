import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncedLeaf
} from '../../../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { makeTerminalTab } from '../../../persistence-session-fixtures'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { resolveOpenTabForSessionId } from '../../workspaces/workspace-session-open-tab-resolution'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { AI_VAULT_METHODS } from './ai-vault'

const WORKTREE_ID = 'repo::/wt'
const SCANNED_AT = '2026-06-29T00:00:00.000Z'

function snapshot(
  worktree: string,
  tabs: RuntimeMobileSessionTabsSnapshot['tabs']
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree,
    publicationEpoch: '1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs
  }
}

function persistedSession(sessionId: string, tabId: string): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: WORKTREE_ID,
    activeTabId: tabId,
    tabsByWorktree: {
      [WORKTREE_ID]: [
        makeTerminalTab({
          id: tabId,
          worktreeId: WORKTREE_ID,
          ptyId: 'stale-pty',
          aiVaultTitle: { agent: 'claude', sessionId, title: 'Stale' }
        })
      ]
    },
    terminalLayoutsByTabId: {}
  }
}

function resolve(
  sessionId: string,
  patch: {
    mobile?: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
    leaves?: ReadonlyMap<string, RuntimeSyncedLeaf>
    tabs?: ReadonlyMap<string, { id: string; aiVaultTitle?: { sessionId: string } | null }>
    ptys?: ReadonlyMap<string, { providerSessionId?: string | null }>
    session?: WorkspaceSessionState | null
    resolveSessionIdForTab?: (tabId: string) => string | null
  } = {}
) {
  return resolveOpenTabForSessionId({
    sessionId,
    mobileSessionTabsByWorktree: patch.mobile ?? new Map(),
    leaves: patch.leaves ?? new Map(),
    tabs: patch.tabs ?? new Map(),
    ptysById: patch.ptys ?? new Map(),
    statusRows: [],
    session: patch.session ?? null,
    resolveSessionIdForTab: patch.resolveSessionIdForTab ?? (() => null)
  })
}

function vaultSession(sessionId: string, title: string): AiVaultSession {
  return {
    id: `local:claude:${sessionId}:/tmp/${sessionId}.jsonl`,
    executionHostId: 'local',
    agent: 'claude',
    sessionId,
    title,
    cwd: '/tmp',
    branch: null,
    model: null,
    filePath: `/tmp/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: SCANNED_AT,
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `claude --resume ${sessionId}`,
    subagent: null
  }
}

describe('resolveOpenTabForSessionId', () => {
  it('returns the open terminal tab and the open agent-session tab', () => {
    const mobile = new Map([
      [
        WORKTREE_ID,
        snapshot(WORKTREE_ID, [
          {
            type: 'terminal',
            id: 'term-1::leaf-1',
            parentTabId: 'term-1',
            leafId: 'leaf-1',
            ptyId: 'pty-1',
            title: 'Terminal',
            isActive: true
          },
          {
            type: 'agent-session',
            id: 'agent-session:sess-chat',
            title: 'Chat',
            sessionId: 'claude:sess-chat',
            agent: 'claude',
            isActive: false
          }
        ])
      ]
    ])
    const ptys = new Map([['pty-1', { providerSessionId: 'sess-term' }]])

    expect(resolve('sess-term', { mobile, ptys })).toEqual({
      worktreeId: WORKTREE_ID,
      tabId: 'term-1',
      leafId: 'leaf-1'
    })
    expect(resolve('sess-chat', { mobile, ptys })).toEqual({
      worktreeId: WORKTREE_ID,
      tabId: 'agent-session:sess-chat'
    })
  })

  it('returns null after the mobile tab closes even when persisted tabs and leaves remain', () => {
    const mobile = new Map([[WORKTREE_ID, snapshot(WORKTREE_ID, [])]])
    const leaves = new Map<string, RuntimeSyncedLeaf>([
      [
        'leaf-1',
        {
          tabId: 'term-1',
          worktreeId: WORKTREE_ID,
          leafId: 'leaf-1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    ])
    const tabs = new Map([['term-1', { id: 'term-1', aiVaultTitle: { sessionId: 'sess-1' } }]])
    const ptys = new Map([['pty-1', { providerSessionId: 'sess-1' }]])

    expect(
      resolve('sess-1', {
        mobile,
        leaves,
        tabs,
        ptys,
        session: persistedSession('sess-1', 'term-1')
      })
    ).toBeNull()
  })

  it('reads persisted tabs when that worktree has no mobile snapshot yet', () => {
    const mobile = new Map([['other-worktree', snapshot('other-worktree', [])]])

    expect(
      resolve('sess-1', {
        mobile,
        session: persistedSession('sess-1', 'term-1')
      })
    ).toEqual({ worktreeId: WORKTREE_ID, tabId: 'term-1' })
  })
})

describe('aiVault.listSessions openTab', () => {
  it('stamps openTab for open structured and terminal sessions', async () => {
    const mobile = new Map([
      [
        WORKTREE_ID,
        snapshot(WORKTREE_ID, [
          {
            type: 'agent-session',
            id: 'agent-session:sess-open',
            title: 'Open',
            sessionId: 'sess-open',
            agent: 'claude',
            isActive: true
          },
          {
            type: 'terminal',
            id: 'term-named::leaf-named',
            parentTabId: 'term-named',
            leafId: 'leaf-named',
            ptyId: 'pty-named',
            title: 'Terminal',
            isActive: false
          }
        ])
      ]
    ])
    const ptys = new Map([['pty-named', { providerSessionId: 'sess-named' }]])
    const listed: AiVaultListResult = {
      sessions: [vaultSession('sess-open', 'Open chat'), vaultSession('sess-named', 'Raw title')],
      issues: [],
      scannedAt: SCANNED_AT
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listSessions reads only these runtime members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
      listAiVaultSessions: vi.fn(async () => listed),
      resolveOpenTabForSession: (sessionId: string) => resolve(sessionId, { mobile, ptys })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'aiVault.listSessions',
      params: { limit: 50 }
    }

    const response = await dispatcher.dispatch(request)

    expect(response).toMatchObject({
      ok: true,
      result: {
        sessions: [
          {
            sessionId: 'sess-open',
            title: 'Open chat',
            openTab: { worktreeId: WORKTREE_ID, tabId: 'agent-session:sess-open' }
          },
          {
            sessionId: 'sess-named',
            title: 'Raw title',
            openTab: { worktreeId: WORKTREE_ID, tabId: 'term-named', leafId: 'leaf-named' }
          }
        ]
      }
    })
  })
})
