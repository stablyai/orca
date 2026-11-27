import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { Store } from '../persistence/loading-store/store'
import { createSqliteTestStore } from '../persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import '../runtime/orchestration/db/contract-constants'
import '../runtime/orchestration/db/messages/mailbox-routing-page'
import '../runtime/orchestration/db/dispatch-row-writer'
import '../runtime/orchestration/db/attempt-outcome-projection'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { ORCHESTRATION_METHODS } from '../runtime/rpc/methods/orchestration/orchestration'
import {
  BOT_ADDRESS,
  BOT_SESSION_ID,
  installStructuredSessionHost,
  makeFixtureBot,
  makeFixtureSessionRecord,
  makeWorkspaceSummary,
  STANDALONE_OTHER_SESSION_ID,
  type SyntheticWorktreeState
} from './bot-work-target-rpc-fixtures.test-fixture'

export {
  BOT_ADDRESS,
  BOT_SESSION_ID,
  expectRpcFailure,
  installStructuredSessionHost,
  makeExplicitWorkspaceTarget,
  makeProjectTarget,
  nextRequestId,
  rpcReq,
  STANDALONE_OTHER_SESSION_ID,
  teardownFollowUpTestFixtures
} from './bot-work-target-rpc-fixtures.test-fixture'

export async function createFollowUpHostFixture(options: {
  hostRef: { current: unknown }
  tempDirs: string[]
  dbs: OrchestrationDb[]
  dbFile?: string
  tag?: string
}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `orca-work-target-followup-${options.tag ?? 'host'}-`))
  )
  options.tempDirs.push(root)
  const botHomePath = join(root, 'bots', 'helper-bot')
  const acmePath = join(root, 'acme-api')
  const otherPath = join(root, 'other-project')
  await Promise.all([
    mkdir(botHomePath, { recursive: true }),
    mkdir(acmePath, { recursive: true }),
    mkdir(otherPath, { recursive: true })
  ])
  const store = createSqliteTestStore(Store, { dataFile: join(root, 'profile', 'state.json') })
  store.addRepo({
    id: 'repo-acme',
    displayName: 'acme-api',
    path: acmePath,
    badgeColor: '',
    addedAt: 1,
    kind: 'git',
    executionHostId: 'local'
  })
  store.addRepo({
    id: 'repo-other',
    displayName: 'other-project',
    path: otherPath,
    badgeColor: '',
    addedAt: 2,
    kind: 'git',
    executionHostId: 'local'
  })
  store.addRepo({
    id: 'repo-ssh',
    displayName: 'ssh-api',
    path: '/srv/ssh-api',
    badgeColor: '',
    addedAt: 3,
    kind: 'git',
    connectionId: 'devbox',
    executionHostId: 'ssh:devbox'
  })
  const projects = [
    {
      id: 'proj-acme',
      displayName: 'acme-api',
      badgeColor: '',
      sourceRepoIds: ['repo-acme'],
      createdAt: 1,
      updatedAt: 1
    }
  ]
  const setups = [
    {
      id: 'setup-acme-local',
      projectId: 'proj-acme',
      hostId: 'local' as const,
      repoId: 'repo-acme',
      path: acmePath,
      displayName: 'acme-api',
      setupState: 'ready' as const,
      setupMethod: 'legacy-repo' as const,
      createdAt: 1,
      updatedAt: 1
    }
  ]
  vi.spyOn(store, 'getProjects').mockImplementation(() => projects)
  vi.spyOn(store, 'getProjectHostSetups').mockImplementation(() => setups)
  const botsGroup = store.createProjectGroup({
    name: 'Bots',
    parentPath: join(root, 'bots'),
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual'
  })
  const botHomeFolder = store.createFolderWorkspace({
    projectGroupId: botsGroup.id,
    folderPath: botHomePath,
    name: 'HelperBot'
  })
  store.saveBot(makeFixtureBot('bot-1', botHomeFolder.id, BOT_SESSION_ID))

  const db = new OrchestrationDb(options.dbFile ?? ':memory:')
  options.dbs.push(db)
  const runtime = new OrcaRuntimeService(store)
  runtime.setOrchestrationDb(db)

  const worktrees = new Map<string, SyntheticWorktreeState>([
    [
      'wt-acme',
      {
        id: 'wt-acme',
        repoId: 'repo-acme',
        path: join(root, 'acme-api-wt'),
        displayName: 'feat/auth-fix',
        branch: 'feat/auth-fix',
        instanceId: 'inst-acme-1',
        hostId: 'local'
      }
    ],
    [
      'wt-other',
      {
        id: 'wt-other',
        repoId: 'repo-other',
        path: join(root, 'other-wt'),
        displayName: 'feat/other',
        branch: 'feat/other',
        instanceId: 'inst-other-1',
        hostId: 'local'
      }
    ],
    [
      'wt-ssh',
      {
        id: 'wt-ssh',
        repoId: 'repo-ssh',
        path: '/srv/ssh-api-wt',
        displayName: 'feat/ssh',
        branch: 'feat/ssh',
        instanceId: 'inst-ssh-1',
        hostId: 'ssh:devbox'
      }
    ]
  ])
  const terminalWorktreeMap = new Map<string, { worktreeId: string; paneKey: string }>([
    [
      'term_acme',
      { worktreeId: 'wt-acme', paneKey: 'tab_acme:11111111-1111-4111-8111-111111111111' }
    ],
    [
      'term_other',
      { worktreeId: 'wt-other', paneKey: 'tab_other:22222222-2222-4222-8222-222222222222' }
    ]
  ])

  const bindRuntimeWorkspaceStubs = (targetRuntime: OrcaRuntimeService) => {
    vi.spyOn(targetRuntime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
    vi.spyOn(targetRuntime, 'showManagedTerminalWorkspace').mockImplementation(
      async (selector, requiredHostId) => {
        const key = selector.startsWith('id:') ? selector.slice(3) : selector
        const entry =
          worktrees.get(key) ??
          [...worktrees.values()].find(
            (wt) => selector === `identity:wt2:${wt.hostId ?? 'local'}:${wt.instanceId}`
          )
        if (!entry || (requiredHostId && (entry.hostId ?? 'local') !== requiredHostId)) {
          throw new Error(`Worktree not found: ${selector}`)
        }
        return makeWorkspaceSummary(entry)
      }
    )
    vi.spyOn(targetRuntime, 'showTerminal').mockImplementation(async (handle) => {
      const found = terminalWorktreeMap.get(handle)
      if (!found) {
        throw new Error(`Terminal not found: ${handle}`)
      }
      const [tabId = 'tab_test', leafId = 'leaf_test'] = found.paneKey.split(':')
      const wt = worktrees.get(found.worktreeId)
      return {
        handle,
        ptyId: null,
        worktreeId: found.worktreeId,
        worktreePath: wt?.path ?? '',
        branch: wt?.branch ?? 'main',
        tabId,
        leafId,
        title: null,
        connected: true,
        writable: true,
        lastOutputAt: null,
        preview: '',
        paneRuntimeId: 1,
        rendererGraphEpoch: 1
      }
    })
    vi.spyOn(targetRuntime, 'getTerminalPaneKey').mockImplementation(
      (handle) => terminalWorktreeMap.get(handle)?.paneKey ?? null
    )
    vi.spyOn(targetRuntime, 'getLiveTerminalPaneKey').mockImplementation(
      (handle) => terminalWorktreeMap.get(handle)?.paneKey ?? null
    )
    vi.spyOn(targetRuntime, 'isTerminalRunningAgent').mockResolvedValue(true)
  }

  bindRuntimeWorkspaceStubs(runtime)
  const records = new Map<string, AgentSessionRecord>([
    [
      BOT_SESSION_ID,
      makeFixtureSessionRecord(BOT_SESSION_ID, folderWorkspaceKey(botHomeFolder.id))
    ],
    [STANDALONE_OTHER_SESSION_ID, makeFixtureSessionRecord(STANDALONE_OTHER_SESSION_ID, 'wt-other')]
  ])
  installStructuredSessionHost(options.hostRef, records)
  const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

  return {
    root,
    store,
    db,
    runtime,
    dispatcher,
    worktrees,
    projects,
    setups,
    records,
    botHomeFolder,
    bindRuntimeWorkspaceStubs
  }
}

export function seedLocalWorker(
  db: OrchestrationDb,
  args: {
    runId: string
    spec: string
    worktreeId: string
    terminalHandle: string
    paneKey: string
    processIncarnation: string
    worktreeInstanceId?: string | null
    hostScope?: string | null
    settled?: boolean
  }
): { dispatchId: string; taskId: string } {
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'terminal', handle: BOT_ADDRESS, orcaSessionId: BOT_SESSION_ID },
    maxDepth: 3,
    taskSpec: args.spec,
    taskRunId: args.runId,
    startOptions: {
      worktree: `id:${args.worktreeId}`,
      resolvedWorktreeId: args.worktreeId,
      resolvedWorktreeInstanceId: args.worktreeInstanceId ?? null,
      agent: 'codex'
    },
    runtimeEpoch: 'runtime-epoch-1'
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: args.terminalHandle,
    paneKey: args.paneKey,
    processIncarnation: args.processIncarnation,
    worktreeId: args.worktreeId,
    worktreeInstanceId: args.worktreeInstanceId ?? null,
    hostScope: args.hostScope ?? JSON.stringify({ kind: 'local', hostId: 'local' }),
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  if (args.settled) {
    db.completeDispatch(started.dispatch.id)
    db.db
      .prepare("UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id = ?")
      .run(started.dispatch.id)
  }
  return { dispatchId: started.dispatch.id, taskId: started.task.id }
}
