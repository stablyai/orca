import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import type {
  OrcaRecoveryDescriptorV1,
  RecoveryAgentBinding
} from '../../../shared/cross-machine-recovery-descriptor'
import { applyCrossMachineRecoveryOp } from '../../../shared/cross-machine-recovery-session-ops'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { CrossMachineRecoveryHost } from './recovery-runtime-host'

export const SOURCE_TAB = randomUUID()
export const SOURCE_LEAF = randomUUID()
export const SOURCE_GROUP = randomUUID()
export const SESSION_ID = '5f1c1c3e-1111-4222-8333-444455556666'

export function emptySession(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}

export function binding(): RecoveryAgentBinding {
  return {
    sourcePaneKey: `${SOURCE_TAB}:${SOURCE_LEAF}`,
    sourceTabId: SOURCE_TAB,
    sourceLeafId: SOURCE_LEAF,
    surface: 'terminal',
    agent: 'claude',
    providerSession: {
      key: 'session_id',
      id: SESSION_ID,
      transcriptPath: '/src/home/.claude/t.jsonl'
    },
    liveness: 'live',
    state: 'working',
    launch: { sourceAgentArgs: '--dangerously-skip-permissions', sourceEnvKeys: ['SECRET'] },
    capturedAt: 10,
    updatedAt: 20,
    lastHumanInputAt: null
  }
}

export function descriptor(): OrcaRecoveryDescriptorV1 {
  const layout = {
    tabs: [
      {
        id: SOURCE_TAB,
        entityId: SOURCE_TAB,
        groupId: SOURCE_GROUP,
        contentType: 'terminal' as const,
        label: 'claude',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      },
      {
        id: '/src/wt/a.ts',
        entityId: '/src/wt/a.ts',
        groupId: SOURCE_GROUP,
        contentType: 'editor' as const,
        label: 'a.ts',
        customLabel: null,
        color: null,
        sortOrder: 1,
        createdAt: 1
      }
    ],
    groups: [{ id: SOURCE_GROUP, activeTabId: SOURCE_TAB, tabOrder: [SOURCE_TAB, '/src/wt/a.ts'] }],
    groupLayout: { type: 'leaf' as const, groupId: SOURCE_GROUP },
    activeGroupId: SOURCE_GROUP,
    terminalTabs: [
      {
        id: SOURCE_TAB,
        title: 'claude',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1,
        startupCwd: '/src/wt/pkg'
      }
    ],
    terminalLayouts: {
      [SOURCE_TAB]: {
        root: { type: 'leaf' as const, leafId: SOURCE_LEAF },
        activeLeafId: SOURCE_LEAF,
        expandedLeafId: null
      }
    },
    startupCwdRelative: { [SOURCE_TAB]: 'pkg' },
    editors: [
      { relativePath: 'a.ts', language: 'typescript' },
      { relativePath: '../escape.ts', language: 'typescript' }
    ],
    activeEditorRelativePath: 'a.ts',
    browsers: [],
    activeBrowserId: null,
    activeTabType: 'terminal' as const,
    activeTabId: SOURCE_TAB
  }
  return {
    version: 1,
    exportedAt: 5,
    source: {
      runtimeId: 'rt-src',
      appVersion: '1.0.0',
      machineName: 'laptop',
      platform: 'darwin',
      executionHostId: 'local'
    },
    repo: { id: 'src-repo', path: '/src/repo', displayName: 'repo' },
    workspace: {
      worktreeId: 'src-repo::/src/wt',
      instanceId: 'inst-src',
      path: '/src/wt',
      branch: 'main',
      meta: {
        displayName: 'wt',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isPinned: false,
        lastActivityAt: 0
      }
    },
    layout,
    presentation: { views: [], preferredClientKey: null, freshness: 'host-only' },
    omittedBindings: [],
    bindings: [binding()]
  }
}

export function fixture(
  options: { live?: boolean; ensure?: CrossMachineRecoveryHost['ensureAgentSession'] } = {}
) {
  const checkout = realpathSync(mkdtempSync(path.join(tmpdir(), 'xmr-import-')))
  mkdirSync(path.join(checkout, '.git'))
  let session = emptySession()
  const meta: Record<string, WorktreeMeta> = {}
  const worktreeId = `repo-1::${checkout}`
  const ensureAgentSession = vi.fn(
    options.ensure ??
      (async () => ({
        terminal: { handle: 'term-1', worktreeId, title: null },
        disposition: 'created' as const
      }))
  )
  const host: CrossMachineRecoveryHost = {
    now: () => 1_000,
    mintId: () => randomUUID(),
    listLocalRepos: () => [{ id: 'repo-1', path: checkout }],
    addRepo: vi.fn(),
    invalidateWorktreeCatalog: vi.fn(),
    resolveWorktree: async () => ({ id: worktreeId, repoId: 'repo-1', instanceId: 'inst-local' }),
    getLocalSession: () => session,
    getWorktreeMeta: (id) => meta[id],
    setRecoveryProvenance: async (id, recoveryProvenance) => {
      meta[id] = { ...meta[id], recoveryProvenance }
    },
    applyOp: async (op) => {
      const next = applyCrossMachineRecoveryOp(session, op)
      session = next.session
      return next.outcome
    },
    ensureAgentSession,
    isProviderSessionLive: () => options.live === true,
    activateWorktree: vi.fn()
  }
  const readCommonDir = async () => '.git'
  return {
    host,
    checkout,
    worktreeId,
    ensureAgentSession,
    readCommonDir,
    getSession: () => session
  }
}
