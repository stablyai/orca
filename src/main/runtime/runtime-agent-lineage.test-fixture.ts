import { OrchestrationDb } from './orchestration/db'
import type { RuntimeAgentLineageTestModule } from '../../shared/runtime-agent-lineage-consumer.test-fixture'
import { RuntimeAgentOrchestrationProjection } from './runtime-agent-orchestration-projection'
import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from './structured-worker-identity'

export const LINEAGE_PARENT = testOrcaSessionId('ca1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
export const LINEAGE_CHILD = testOrcaSessionId('ce3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64')
export const canonicalChatRow = (id: string): string =>
  structuredAgentSessionPaneKey(structuredAgentSessionTabId(id), id)

/** Production assignment projection and host row attachment; no preassembled agent output. */
export function publicLineageFixture(worktreeId = 'repo::/workspace') {
  const db = new OrchestrationDb(':memory:')
  const privateHandle = mintStructuredWorkerHandle()
  const privatePane = mintStructuredWorkerPaneKey(LINEAGE_CHILD)
  const run = db.createRun({
    objective: 'lineage',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: LINEAGE_PARENT
  })
  db.createDispatchContext({
    taskId: db.createTask({ runId: run.id, spec: 'Build the worker result' }).id,
    assigneeHandle: privateHandle,
    assigneePaneKey: privatePane,
    processIncarnation: structuredWorkerProcessIncarnation(LINEAGE_CHILD),
    creator: { kind: 'system' },
    maxDepth: 99
  })
  const projection = new RuntimeAgentOrchestrationProjection({
    getDb: () => db,
    getLeaves: () => [],
    getPtys: () => [],
    getSessionRecords: () => null,
    paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
    issueLeafHandle: () => '',
    issuePtyHandle: () => '',
    makePaneKey: () => '',
    getWorktreeId: () => null,
    getHandleForPaneKey: () => null,
    getPaneKey: () => null,
    getDispatchAuthority: () => null,
    getAgentStatusSnapshot: () => []
  })
  const updatedAt = Date.now()
  const build = (): RuntimeWorktreePsSummary => {
    const row: RuntimeWorktreePsSummary = {
      worktreeId,
      workspaceKind: worktreeId.startsWith('folder:') ? 'folder-workspace' : 'git',
      repoId: 'repo',
      repo: 'repo',
      path: '/workspace',
      branch: 'main',
      isArchived: false,
      isMainWorktree: true,
      hasHostSidebarActivity: false,
      parentWorktreeId: null,
      childWorktreeIds: [],
      displayName: 'Workspace',
      workspaceStatus: '',
      sortOrder: 0,
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      comment: '',
      isPinned: false,
      isActive: false,
      unread: false,
      liveTerminalCount: 0,
      hasAttachedPty: false,
      lastOutputAt: null,
      preview: '',
      status: 'inactive',
      agents: []
    }
    const sources = new Map<string, RuntimeWorktreeAgentSource>(
      [LINEAGE_PARENT, LINEAGE_CHILD].map((id) => [
        canonicalChatRow(id),
        {
          paneKey: canonicalChatRow(id),
          connectionId: null,
          worktreeId,
          state: 'working',
          agentType: 'codex',
          prompt: id === LINEAGE_PARENT ? 'Coordinate work' : 'Implement work',
          lastAssistantMessage: null,
          toolName: null,
          toolInput: null,
          interrupted: false,
          stateStartedAt: 1,
          updatedAt,
          structuredHost: 'owned'
        }
      ])
    )
    const summaries = new Map([[worktreeId, row]])
    attachRuntimeWorktreeAgentRows({
      summaries,
      rowSources: sources,
      terminalTitleEvidenceByWorktreeId: new Map(),
      orchestrationByPaneKey: projection.buildByPaneKey(),
      getSummary: (id) => summaries.get(id) ?? null
    })
    return row
  }
  return { db, projection, build, privateHandle, privatePane, run }
}

export default {
  publicLineageFixture,
  canonicalChatRow,
  LINEAGE_PARENT,
  LINEAGE_CHILD
} satisfies RuntimeAgentLineageTestModule
