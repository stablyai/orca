import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotSchema, type Bot } from '../../shared/bot-types'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY
} from '../../shared/orchestration/orchestration-runtime-capabilities'
import type { Repo } from '../../shared/repository/repo-types'
import { removeTempDirs } from '../../shared/testing/remove-temp-dirs.test-support'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../shared/workspace/identity/workspace-scope'
import { formatOrcaSessionAddress } from '../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address-test-fixture'
import { createWorktreeIdentity } from '../../shared/worktree/identity'
import type { OrchestrationSessionCaller } from '../runtime/orchestration/addressing/orchestration-caller-identity'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence/persistence-test-harness'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import '../runtime/orchestration/db/contract-constants'
import '../runtime/orchestration/db/messages/mailbox-routing-page'
import '../runtime/orchestration/db/dispatch-row-writer'
import '../runtime/orchestration/db/attempt-outcome-projection'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import { routeRemoteOwnedCall } from '../runtime/orchestration/federation/remote-owned/remote-owned-route'
import { eraseRpcMethods } from '../runtime/rpc/core'
import {
  ORCHESTRATION_WORKER_START_METHODS,
  startWorker
} from '../runtime/rpc/methods/orchestration/worker/worker-start-method'
import type { ResolvedWorktree } from '../runtime/workspaces/catalog/runtime-worktree-path-identity'
import {
  validateBotWorkTarget,
  type BotWorkTargetValidationDeps
} from './bot-work-target-validation'

const tempDirs: string[] = []
const dbs: OrchestrationDb[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const db of dbs.splice(0)) {
    db.close()
  }
  await closeTestStores()
  await removeTempDirs(tempDirs.splice(0))
})

async function git(cwd: string, ...argv: string[]): Promise<string> {
  return (await gitExecFileAsync(argv, { cwd })).stdout.trim()
}

function makeBot(id: string, folderWorkspaceId: string, chatSessionId: string): Bot {
  return BotSchema.parse({
    id,
    name: 'HelperBot',
    hostId: 'local',
    folder: 'helper-bot',
    folderWorkspaceId,
    agent: 'codex',
    avatar: null,
    paused: false,
    notifications: {
      needsPermission: false,
      taskComplete: false,
      couldNotFinish: false
    },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId,
    createdAt: 1,
    updatedAt: 1
  })
}

function makeBotCaller(rawSessionId: string, workspaceId: string): OrchestrationSessionCaller {
  const sessionId = testOrcaSessionId(rawSessionId)
  return {
    address: formatOrcaSessionAddress(sessionId),
    terminalHandle: null,
    paneKey: null,
    orcaSessionId: sessionId,
    sessionId,
    workspaceId
  }
}

async function createRealGitRuntimeFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-work-target-rt-')))
  tempDirs.push(root)

  const repoPath = join(root, 'acme-api')
  await git(root, 'init', '--quiet', 'acme-api')
  await git(repoPath, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  await git(repoPath, 'config', 'user.name', 'Work Target Test')
  await git(repoPath, 'config', 'user.email', 'test@example.com')
  await git(repoPath, 'config', 'core.hooksPath', join(root, 'no-hooks'))
  await git(repoPath, 'commit', '--quiet', '--allow-empty', '-m', 'initial')

  const botHomePath = join(root, 'bots', 'helper-bot')
  const runbooksPath = join(root, 'runbooks')
  const workspacesDir = join(root, 'workspaces')
  await mkdir(botHomePath, { recursive: true })
  await mkdir(runbooksPath, { recursive: true })
  await mkdir(workspacesDir, { recursive: true })

  const store = createSqliteTestStore(Store, { dataFile: join(root, 'profile', 'state.json') })
  store.updateSettings({ workspaceDir: workspacesDir, nestWorkspaces: false })

  const localRepo: Repo = {
    id: 'repo-acme-local',
    displayName: 'acme-api',
    path: repoPath,
    badgeColor: '',
    addedAt: 1,
    kind: 'git',
    executionHostId: 'local'
  }
  const sshRepo: Repo = {
    id: 'repo-acme-ssh',
    displayName: 'acme-api',
    path: '/srv/ssh/acme-api',
    badgeColor: '',
    addedAt: 1,
    kind: 'git',
    executionHostId: 'ssh:box-build',
    connectionId: 'box-build'
  }
  store.addRepo(localRepo)
  store.addRepo(sshRepo)
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
  const opsGroup = store.createProjectGroup({
    name: 'Operations',
    parentPath: root,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual'
  })
  const runbooksFolder = store.createFolderWorkspace({
    projectGroupId: opsGroup.id,
    folderPath: runbooksPath,
    name: 'runbooks'
  })
  store.saveBot(makeBot('bot-1', botHomeFolder.id, 'sess-bot-1'))

  const db = new OrchestrationDb(':memory:')
  dbs.push(db)
  const runtime = new OrcaRuntimeService(store)
  runtime.setOrchestrationDb(db)

  return {
    root,
    repoPath,
    workspacesDir,
    store,
    db,
    runtime,
    localRepo,
    sshRepo,
    botHomeFolder,
    runbooksFolder
  }
}

function makeResolvedWorktree(
  overrides: Partial<ResolvedWorktree> & Pick<ResolvedWorktree, 'id' | 'repoId' | 'path'>
): ResolvedWorktree {
  const hostId = overrides.hostId ?? 'local'
  const instanceId = overrides.instanceId ?? 'inst-default'
  return {
    hostId,
    instanceId,
    identity: createWorktreeIdentity({
      worktreeId: overrides.id,
      executionHostId: hostId,
      instanceId
    }),
    displayName: overrides.displayName ?? 'main',
    branch: overrides.branch ?? 'main',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: {
      path: overrides.path,
      head: 'abc123',
      branch: overrides.branch ?? 'main',
      isBare: false,
      isMainWorktree: false
    },
    ...overrides
  }
}

function stubWorkerTerminalLifecycle(
  runtime: OrcaRuntimeService,
  botHomeFolderId: string,
  botTerminalHandle = 'term_bot'
) {
  const createTerminalCalls: unknown[][] = []
  let createdCount = 0

  vi.spyOn(runtime, 'showTerminal').mockImplementation(async (handle) => {
    if (handle === botTerminalHandle) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub returns the terminal fields read by local-worker-start during this test.
      return {
        handle: botTerminalHandle,
        worktreeId: folderWorkspaceKey(botHomeFolderId),
        tabId: 'tab-bot',
        leafId: 'leaf-bot',
        ptyId: 'pty-bot',
        title: 'HelperBot',
        status: 'running'
      } as unknown as Awaited<ReturnType<OrcaRuntimeService['showTerminal']>>
    }
    throw new Error('terminal_not_found')
  })
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === botTerminalHandle ? 'tab-bot:leaf-bot' : `tab-${handle}:leaf-${handle}`
  )
  vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
    runtime.getTerminalPaneKey(handle)
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
    (handle) => `runtime_test:${handle}:1`
  )
  vi.spyOn(runtime, 'createTerminal').mockImplementation(async (...args) => {
    createTerminalCalls.push(args)
    createdCount += 1
    const handle = `term_worker_${createdCount}`
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub returns the terminal fields read by local-worker-start during this test.
    return {
      handle,
      worktreeId: typeof args[0] === 'string' ? args[0] : 'wt-created',
      title: 'worker',
      tabId: `tab-${handle}`,
      leafId: `leaf-${handle}`,
      surface: 'background'
    } as unknown as Awaited<ReturnType<OrcaRuntimeService['createTerminal']>>
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub returns the listTerminals fields read by local-worker-start during this test.
  vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
    terminals: [],
    totalCount: 0
  } as unknown as Awaited<ReturnType<OrcaRuntimeService['listTerminals']>>)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub returns the waitForTerminal fields read by local-worker-start during this test.
  vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
    satisfied: true,
    status: 'ready'
  } as unknown as Awaited<ReturnType<OrcaRuntimeService['waitForTerminal']>>)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub returns the sendTerminal fields read by local-worker-start during this test.
  vi.spyOn(runtime, 'sendTerminal').mockResolvedValue({
    handle: 'term_worker_1',
    bytesWritten: 10,
    submitted: true,
    prompt: { delivery: 'accepted', queued: false }
  } as unknown as Awaited<ReturnType<OrcaRuntimeService['sendTerminal']>>)

  return { createTerminalCalls }
}

describe('runtime launch boundaries, real worktree creation, host twins, and pairing fences', () => {
  it('creates a real local Git worktree under the selected project (not nested under Bot Home) while keeping untargeted bot creations under Bot Home and rejecting SSH Git creates', async () => {
    const { runtime, store, localRepo, sshRepo, botHomeFolder } =
      await createRealGitRuntimeFixture()
    stubWorkerTerminalLifecycle(runtime, botHomeFolder.id)

    // Real runtime rejects SSH Git project worktree creation with SshHostNotServedError.
    await expect(
      runtime.createManagedWorktree({
        repoSelector: `id:${sshRepo.id}`,
        name: 'ssh-attempt',
        activate: false
      })
    ).rejects.toBeInstanceOf(SshHostNotServedError)

    // Validate local Git project target and bind it to the bot session's active turn.
    const botHomeKey = folderWorkspaceKey(botHomeFolder.id)
    const validationDeps: BotWorkTargetValidationDeps = {
      hostId: 'local',
      isBotHome: (workspaceId) => workspaceId === botHomeKey,
      store: () => store,
      showManagedTerminalWorkspace: (selector, requiredHostId) =>
        runtime.showManagedTerminalWorkspace(selector, requiredHostId),
      getSshConnectionStatus: () => 'connected'
    }
    const validated = await validateBotWorkTarget(
      validationDeps,
      {
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: botHomeKey,
          workspaceKind: 'folder'
        }
      },
      {
        kind: 'project',
        hostId: 'local',
        repoId: localRepo.id,
        displayName: localRepo.displayName
      }
    )
    expect(validated.ok).toBe(true)
    if (!validated.ok) {
      throw new Error('expected valid local git project')
    }
    runtime.botWorkTargets.setForTurn('sess-bot-1', validated.placement)

    // Launch worker from the bot session with no explicit --repo/--worktree (and verify real Git creation).
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: false,
      reason: 'agent'
    })
    const receiptRaw = await startWorker(
      {
        from: 'term_bot',
        spec: 'Implement feature in acme-api',
        worktree: 'current',
        name: 'targeted-project-wt',
        agent: 'codex',
        setup: 'skip'
      },
      {
        runtime,
        orchestrationCaller: makeBotCaller('sess-bot-1', botHomeKey)
      }
    )
    const effects =
      typeof receiptRaw === 'object' &&
      receiptRaw !== null &&
      'effects' in receiptRaw &&
      Array.isArray(receiptRaw.effects)
        ? receiptRaw.effects
        : []
    const worktreeEffect = effects.find(
      (effect): effect is { kind: string; action?: string; id?: string } =>
        typeof effect === 'object' &&
        effect !== null &&
        'kind' in effect &&
        effect.kind === 'worktree'
    )
    expect(worktreeEffect?.action).toBe('created_top_level')
    expect(worktreeEffect?.id).toBeDefined()
    const createdWorktreeId = worktreeEffect!.id!
    const createdPath = createdWorktreeId.split('::')[1]!
    expect(existsSync(createdPath)).toBe(true)

    // Targeted project launch must NOT be nested under Bot Home!
    const targetedLineage = store.getWorkspaceLineage(worktreeWorkspaceKey(createdWorktreeId))
    expect(targetedLineage).toBeUndefined()

    // Contrast: an untargeted create from the exact same bot terminal STILL nests under Bot Home.
    const untargeted = await runtime.createManagedWorktree({
      repoSelector: `id:${localRepo.id}`,
      name: 'untargeted-bot-wt',
      activate: false,
      runHooks: false,
      setupDecision: 'skip',
      lineage: {
        noParent: true,
        callerTerminalHandle: 'term_bot'
      }
    })
    expect(store.getWorkspaceLineage(worktreeWorkspaceKey(untargeted.worktree.id))).toMatchObject({
      parentWorkspaceKey: botHomeKey
    })
  })

  it('launches existing SSH workspaces on their exact SSH identity selector, rejects host-twin disappearance and same-path delete/recreate with zero launch, and enforces folder host scoping', async () => {
    const { runtime, store, db, botHomeFolder, runbooksFolder } =
      await createRealGitRuntimeFixture()
    const { createTerminalCalls } = stubWorkerTerminalLifecycle(runtime, botHomeFolder.id)

    // Folder workspace host scoping: requesting a local folder under an SSH host must throw selector_not_found, never fall back to local.
    await expect(
      runtime.showManagedTerminalWorkspace(
        `id:${folderWorkspaceKey(runbooksFolder.id)}`,
        'ssh:box-build'
      )
    ).rejects.toThrow('selector_not_found')

    // Connected SSH existing workspace launches via terminal mode with exact identity selector.
    const sshWorktree = makeResolvedWorktree({
      id: 'repo-acme-ssh::/srv/ssh/acme-api',
      repoId: 'repo-acme-ssh',
      hostId: 'ssh:box-build',
      instanceId: 'inst-ssh-1',
      displayName: 'main',
      path: '/srv/ssh/acme-api'
    })
    const localTwinWorktree = makeResolvedWorktree({
      id: 'repo-twin::/shared/wt',
      repoId: 'repo-twin',
      hostId: 'local',
      instanceId: 'inst-twin-local',
      displayName: 'twin-local',
      path: '/shared/wt'
    })
    const sshTwinWorktree = makeResolvedWorktree({
      id: 'repo-twin::/shared/wt',
      repoId: 'repo-twin',
      hostId: 'ssh:box-build',
      instanceId: 'inst-twin-ssh',
      displayName: 'twin-ssh',
      path: '/shared/wt'
    })
    let liveWorktrees: ResolvedWorktree[] = [sshWorktree, localTwinWorktree, sshTwinWorktree]

    const showSpy = vi
      .spyOn(runtime, 'showManagedTerminalWorkspace')
      .mockImplementation(async (selector, requiredHostId) => {
        const matches = liveWorktrees.filter((wt) => {
          if (requiredHostId && wt.hostId !== requiredHostId) {
            return false
          }
          if (selector.startsWith('identity:')) {
            return wt.identity?.key === selector.slice('identity:'.length)
          }
          const id = selector.startsWith('id:') ? selector.slice(3) : selector
          return wt.id === id
        })
        if (matches.length !== 1) {
          throw new Error(matches.length > 1 ? 'selector_ambiguous' : 'selector_not_found')
        }
        return matches[0]!
      })
    const supportSpy = vi
      .spyOn(runtime, 'getStructuredAgentSessionCreateSupport')
      .mockImplementation(async (selector) =>
        selector.includes('ssh%3Abox-build')
          ? { supported: false, reason: 'remote' }
          : { supported: false, reason: 'agent' }
      )

    const botCaller = makeBotCaller('sess-bot-1', folderWorkspaceKey(botHomeFolder.id))

    // 1) Existing SSH workspace launches with exact identity selector and terminal downgrade.
    runtime.botWorkTargets.setForTurn('sess-bot-1', {
      mode: 'existing',
      worktreeSelector: `identity:${sshWorktree.identity!.key}`,
      targetHostId: 'ssh:box-build',
      expectedWorkspaceInstanceId: 'inst-ssh-1',
      canonicalTarget: {
        kind: 'workspace',
        hostId: 'ssh:box-build',
        repoId: 'repo-acme-ssh',
        repoKind: 'git',
        workspaceId: sshWorktree.id,
        workspaceInstanceId: 'inst-ssh-1',
        workspaceKind: 'git-worktree',
        displayName: 'main'
      }
    })
    await startWorker(
      {
        from: 'term_bot',
        spec: 'Inspect SSH repo',
        worktree: 'current',
        agent: 'codex'
      },
      { runtime, orchestrationCaller: botCaller }
    )
    expect(showSpy).toHaveBeenCalledWith(`identity:${sshWorktree.identity!.key}`, 'ssh:box-build')
    expect(supportSpy).toHaveBeenCalledWith(
      `identity:${sshWorktree.identity!.key}`,
      'codex',
      expect.anything()
    )
    expect(createTerminalCalls[0]?.[0]).toBe(`identity:${sshWorktree.identity!.key}`)

    // 2) Same-ID host-twin disappears on selected host while other-host survivor remains -> fails with ZERO launch!
    const launchesBeforeTwinFail = createTerminalCalls.length
    const runsBeforeTwinFail = db.listRuns().runs.length
    runtime.botWorkTargets.setForTurn('sess-bot-1', {
      mode: 'existing',
      worktreeSelector: `identity:${localTwinWorktree.identity!.key}`,
      targetHostId: 'local',
      expectedWorkspaceInstanceId: 'inst-twin-local',
      canonicalTarget: {
        kind: 'workspace',
        hostId: 'local',
        repoId: 'repo-twin',
        repoKind: 'git',
        workspaceId: localTwinWorktree.id,
        workspaceInstanceId: 'inst-twin-local',
        workspaceKind: 'git-worktree',
        displayName: 'twin-local'
      }
    })
    // Local twin vanishes; only SSH twin at the exact same worktree ID survives.
    liveWorktrees = [sshWorktree, sshTwinWorktree]
    await expect(
      startWorker(
        {
          from: 'term_bot',
          spec: 'Must not fall back to SSH survivor',
          worktree: `id:${localTwinWorktree.id}`,
          agent: 'codex'
        },
        { runtime, orchestrationCaller: botCaller }
      )
    ).rejects.toThrow('selector_not_found')
    expect(createTerminalCalls.length).toBe(launchesBeforeTwinFail)
    expect(db.listRuns().runs.length).toBe(runsBeforeTwinFail)

    // 3) Delete + recreate at the exact same Git worktree path (same ID, new instanceId) -> fails with ZERO launch!
    const recreatedLocalTwin = makeResolvedWorktree({
      id: 'repo-twin::/shared/wt',
      repoId: 'repo-twin',
      hostId: 'local',
      instanceId: 'inst-twin-local-RECREATED',
      displayName: 'twin-local',
      path: '/shared/wt'
    })
    liveWorktrees = [sshWorktree, recreatedLocalTwin]
    await expect(
      startWorker(
        {
          from: 'term_bot',
          spec: 'Must reject recreated occupant',
          worktree: `id:${localTwinWorktree.id}`,
          agent: 'codex'
        },
        { runtime, orchestrationCaller: botCaller }
      )
    ).rejects.toThrow(/selector_not_found|changed after validation/)
    expect(createTerminalCalls.length).toBe(launchesBeforeTwinFail)

    // 4) Twin repo disappears on local while SSH twin with same repoId survives -> fails with ZERO createManagedWorktree!
    const createWorktreeSpy = vi.spyOn(runtime, 'createManagedWorktree')
    store.addRepo({
      id: 'repo-same-id',
      displayName: 'twin-repo',
      path: '/srv/ssh/twin-repo',
      badgeColor: '',
      addedAt: 1,
      kind: 'git',
      executionHostId: 'ssh:box-build',
      connectionId: 'box-build'
    })
    runtime.botWorkTargets.setForTurn('sess-bot-1', {
      mode: 'new-top-level',
      repoSelector: 'id:repo-same-id',
      targetHostId: 'local',
      canonicalTarget: {
        kind: 'project',
        hostId: 'local',
        repoId: 'repo-same-id',
        repoKind: 'git',
        displayName: 'twin-repo'
      }
    })
    await expect(
      startWorker(
        {
          from: 'term_bot',
          spec: 'Must not resolve SSH repo twin',
          repo: 'id:repo-same-id',
          worktree: 'new-top-level',
          agent: 'codex'
        },
        { runtime, orchestrationCaller: botCaller }
      )
    ).rejects.toThrow('repo_not_found')
    expect(createWorktreeSpy).not.toHaveBeenCalled()

    // 5) Untargeted turn preserves explicitly different physical destination untouched.
    runtime.botWorkTargets.clearForTurn('sess-bot-1')
    liveWorktrees = [recreatedLocalTwin]
    await startWorker(
      {
        from: 'term_bot',
        spec: 'Untargeted explicit destination',
        worktree: `id:${recreatedLocalTwin.id}`,
        agent: 'codex'
      },
      { runtime, orchestrationCaller: botCaller }
    )
    expect(createTerminalCalls.length).toBe(launchesBeforeTwinFail + 1)
    expect(createTerminalCalls.at(-1)?.[0]).toBe(`identity:${recreatedLocalTwin.identity!.key}`)
  })

  it('rejects paired-server worker launches when pairing revision or fingerprint changes between validation and start (remote-owned and legacy federated) and avoids Bot Home nesting on paired new-top-level', async () => {
    const { runtime, botHomeFolder } = await createRealGitRuntimeFixture()
    stubWorkerTerminalLifecycle(runtime, botHomeFolder.id)

    const botCaller = makeBotCaller('sess-bot-1', folderWorkspaceKey(botHomeFolder.id))
    let currentPairingRevision = 7
    let currentPeerFingerprint = 'fp-build-v7'

    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockImplementation(async (selector) => {
      if (selector !== 'env-build' && selector !== 'Build Server') {
        throw new Error('server_not_found')
      }
      return {
        environmentId: 'env-build',
        name: 'Build Server',
        pairingRevision: currentPairingRevision,
        peerFingerprint: currentPeerFingerprint
      }
    })
    const remoteCallSpy = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_envId, method, params) => {
        if (method === 'status.get') {
          return {
            runtimeId: 'rt-build',
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
              ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY
            ]
          }
        }
        if (method === 'orchestration.federationAttachStart') {
          const taskId =
            typeof params === 'object' &&
            params !== null &&
            'taskId' in params &&
            typeof params.taskId === 'string'
              ? params.taskId
              : 'task_1'
          return {
            state: 'ready',
            dispatchId: 'ctx_remote_1',
            taskId,
            worktreeId: 'remote-acme::/srv/wt-1',
            terminalHandle: 'term_remote_1',
            setup: {
              requested: 'inherit',
              effective: 'skip',
              source: 'orchestration_default',
              hookFound: false,
              startupPolicy: 'start-immediately',
              state: 'skipped'
            },
            effects: []
          }
        }
        return {}
      })

    runtime.botWorkTargets.setForTurn('sess-bot-1', {
      mode: 'new-top-level',
      repoSelector: 'id:remote-acme',
      onEnvironmentId: 'env-build',
      onExpectedPairingRevision: 7,
      onExpectedPeerFingerprint: 'fp-build-v7',
      canonicalTarget: {
        kind: 'project',
        hostId: 'runtime:env-build',
        repoId: 'remote-acme',
        repoKind: 'git',
        displayName: 'acme-api',
        hostLabel: 'Build Server'
      }
    })

    const workerStartMethod = eraseRpcMethods(ORCHESTRATION_WORKER_START_METHODS)[0]!

    // 1) Pairing revision bumps 7 -> 8 before worker-start: routeRemoteOwnedCall refuses BEFORE any remote RPC, even when bot omits --on!
    currentPairingRevision = 8
    await expect(
      routeRemoteOwnedCall(
        runtime,
        workerStartMethod,
        { id: 'req-1', authToken: 'tok-test', method: 'orchestration.workerStart', params: {} },
        { from: 'term_bot', spec: 'Run build', worktree: 'current' },
        { runtime, orchestrationCaller: botCaller }
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof OrchestrationError &&
        error.code === 'server_pairing_changed' &&
        typeof error.data === 'object' &&
        error.data !== null &&
        'effectsApplied' in error.data &&
        error.data.effectsApplied === false
    )
    expect(remoteCallSpy).not.toHaveBeenCalled()

    // 2) Same refusal when bot echoes matching explicit --on env-build --repo id:remote-acme --worktree new-top-level.
    await expect(
      routeRemoteOwnedCall(
        runtime,
        workerStartMethod,
        { id: 'req-2', authToken: 'tok-test', method: 'orchestration.workerStart', params: {} },
        {
          from: 'term_bot',
          on: 'env-build',
          repo: 'id:remote-acme',
          worktree: 'new-top-level',
          spec: 'Run build'
        },
        { runtime, orchestrationCaller: botCaller }
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof OrchestrationError && error.code === 'server_pairing_changed'
    )
    expect(remoteCallSpy).not.toHaveBeenCalled()

    // 3) Legacy startFederatedWorker ALSO rejects changed peerFingerprint BEFORE status.get!
    currentPairingRevision = 7
    currentPeerFingerprint = 'fp-build-DIFFERENT'
    await expect(
      startWorker(
        {
          from: 'term_bot',
          spec: 'Run legacy build',
          worktree: 'current',
          agent: 'codex'
        },
        {
          runtime,
          orchestrationCaller: botCaller,
          orchestrationMutation: {
            requestId: 'req-fed-1',
            callerFingerprint: 'caller-fp-1',
            method: 'orchestration.workerStart',
            payloadHash: 'pf-1'
          }
        }
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof OrchestrationError && error.code === 'server_pairing_changed'
    )
    expect(remoteCallSpy).not.toHaveBeenCalled()

    // 4) Matching pairing revision + fingerprint succeeds on legacy startFederatedWorker with NO crossStoreParent (not nested under Bot Home).
    currentPeerFingerprint = 'fp-build-v7'
    await startWorker(
      {
        from: 'term_bot',
        spec: 'Run legacy build',
        worktree: 'current',
        agent: 'codex'
      },
      {
        runtime,
        orchestrationCaller: botCaller,
        orchestrationMutation: {
          requestId: 'req-fed-2',
          callerFingerprint: 'caller-fp-1',
          method: 'orchestration.workerStart',
          payloadHash: 'pf-2'
        }
      }
    )
    const attachCall = remoteCallSpy.mock.calls.find(
      (call) => call[1] === 'orchestration.federationAttachStart'
    )
    expect(attachCall).toBeDefined()
    expect(attachCall?.[2]).toMatchObject({
      repo: 'id:remote-acme',
      worktree: 'new-top-level'
    })
    const attachParams = attachCall?.[2]
    expect(
      typeof attachParams === 'object' &&
        attachParams !== null &&
        'crossStoreParent' in attachParams
        ? attachParams.crossStoreParent
        : undefined
    ).toBeUndefined()
    expect(attachCall?.[5]).toMatchObject({ expectedEnvironmentPairingRevision: 7 })
  })
})
