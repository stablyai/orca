import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotSchema, type Bot } from '../../shared/bot-types'
import { formatOrcaSessionAddress } from '../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address-test-fixture'
import { removeTempDirs } from '../../shared/testing/remove-temp-dirs.test-support'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { OrchestrationSessionCaller } from '../runtime/orchestration/addressing/orchestration-caller-identity'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence/persistence-test-harness'
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
import { resolveBotTurnWorkTargetToWorkerStart } from './bot-turn-work-target'

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

async function createPlacementRuntimeFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-work-target-place-')))
  tempDirs.push(root)
  const botHomePath = join(root, 'bots', 'helper-bot')
  await mkdir(botHomePath, { recursive: true })
  const store = createSqliteTestStore(Store, { dataFile: join(root, 'profile', 'state.json') })
  store.addRepo({
    id: 'repo-acme-local',
    displayName: 'acme-api',
    path: join(root, 'acme-api'),
    badgeColor: '',
    addedAt: 1,
    kind: 'git',
    executionHostId: 'local'
  })
  store.addRepo({
    id: 'repo-other-project',
    displayName: 'other-project',
    path: join(root, 'other-project'),
    badgeColor: '',
    addedAt: 1,
    kind: 'git',
    executionHostId: 'local'
  })
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
  store.saveBot(makeBot('bot-1', botHomeFolder.id, 'sess-bot-1'))
  const db = new OrchestrationDb(':memory:')
  dbs.push(db)
  const runtime = new OrcaRuntimeService(store)
  runtime.setOrchestrationDb(db)
  return { runtime, db, botHomeFolder }
}

function expectSyncConflict(fn: () => unknown): void {
  try {
    fn()
    throw new Error('expected OrchestrationError conflict')
  } catch (error) {
    if (!(error instanceof OrchestrationError)) {
      throw error
    }
    expect(error.code).toBe('invalid_argument')
    expect(error.data).toMatchObject({ effectsApplied: false })
  }
}

describe('bot turn work-target placement conflict enforcement', () => {
  it('completes compatible omissions, preserves matching explicit flags, refuses conflicts and unverified terminal/follow-up reuse, and leaves untargeted turns untouched', () => {
    const projectPlacement = {
      mode: 'new-top-level' as const,
      repoSelector: 'id:repo-acme-local',
      targetHostId: 'local' as const,
      canonicalTarget: {
        kind: 'project' as const,
        hostId: 'local',
        repoId: 'repo-acme-local',
        repoKind: 'git' as const,
        displayName: 'acme-api'
      }
    }
    const pairedProjectPlacement = {
      mode: 'new-top-level' as const,
      repoSelector: 'id:remote-acme',
      onEnvironmentId: 'env-build',
      onExpectedPairingRevision: 7,
      onExpectedPeerFingerprint: 'fp-build-v7',
      canonicalTarget: {
        kind: 'project' as const,
        hostId: 'runtime:env-build',
        repoId: 'remote-acme',
        repoKind: 'git' as const,
        displayName: 'acme-api',
        hostLabel: 'Build Server',
        pairingRevision: 7,
        peerFingerprint: 'fp-build-v7'
      }
    }
    const existingPlacement = {
      mode: 'existing' as const,
      worktreeSelector: 'identity:wt2:local:inst-auth-1',
      targetHostId: 'local' as const,
      expectedWorkspaceInstanceId: 'inst-auth-1',
      canonicalTarget: {
        kind: 'workspace' as const,
        hostId: 'local',
        repoId: 'repo-acme-local',
        repoKind: 'git' as const,
        workspaceId: 'wt-auth',
        workspaceInstanceId: 'inst-auth-1',
        workspaceKind: 'git-worktree' as const,
        displayName: 'feat/auth-fix'
      }
    }

    expect(
      resolveBotTurnWorkTargetToWorkerStart({ worktree: 'current' }, projectPlacement, false)
    ).toEqual({
      params: { repo: 'id:repo-acme-local', worktree: 'new-top-level' },
      enforcement: projectPlacement
    })
    expect(
      resolveBotTurnWorkTargetToWorkerStart(
        { repo: 'id:repo-acme-local', worktree: 'new-top-level' },
        projectPlacement,
        false
      )
    ).toEqual({
      params: { repo: 'id:repo-acme-local', worktree: 'new-top-level' },
      enforcement: projectPlacement
    })
    // Omitting --on on a paired-server targeted turn completes --on safely instead of dropping to local.
    expect(
      resolveBotTurnWorkTargetToWorkerStart(
        { repo: 'id:remote-acme', worktree: 'new-top-level' },
        pairedProjectPlacement,
        false
      )
    ).toEqual({
      params: { on: 'env-build', repo: 'id:remote-acme', worktree: 'new-top-level' },
      enforcement: pairedProjectPlacement
    })
    // Matching id:<workspaceId> upgrades to the occupant-exact identity selector with enforcement.
    expect(
      resolveBotTurnWorkTargetToWorkerStart({ worktree: 'id:wt-auth' }, existingPlacement, false)
    ).toEqual({
      params: { worktree: 'identity:wt2:local:inst-auth-1' },
      enforcement: existingPlacement
    })

    // Conflicting flags, terminal reuse, follow-ups, and paired --origin must fail closed with zero effects.
    expectSyncConflict(() =>
      resolveBotTurnWorkTargetToWorkerStart(
        { repo: 'id:different-repo', worktree: 'new-top-level' },
        projectPlacement,
        false
      )
    )
    expectSyncConflict(() =>
      resolveBotTurnWorkTargetToWorkerStart(
        { repo: 'id:repo-acme-local', worktree: 'new-child' },
        projectPlacement,
        false
      )
    )
    expectSyncConflict(() =>
      resolveBotTurnWorkTargetToWorkerStart(
        { on: 'env-other', repo: 'id:repo-acme-local', worktree: 'new-top-level' },
        projectPlacement,
        false
      )
    )
    expectSyncConflict(() =>
      resolveBotTurnWorkTargetToWorkerStart(
        { on: 'env-other', repo: 'id:remote-acme', worktree: 'new-top-level' },
        pairedProjectPlacement,
        false
      )
    )
    expectSyncConflict(() =>
      resolveBotTurnWorkTargetToWorkerStart(
        { terminal: 'term-different-workspace' },
        projectPlacement,
        false
      )
    )
    expectSyncConflict(() =>
      resolveBotTurnWorkTargetToWorkerStart(
        { terminal: 'term-unverified' },
        existingPlacement,
        false
      )
    )
    expectSyncConflict(() =>
      resolveBotTurnWorkTargetToWorkerStart({ worktree: 'current' }, projectPlacement, true)
    )
    expectSyncConflict(() =>
      resolveBotTurnWorkTargetToWorkerStart({ worktree: 'current' }, existingPlacement, true)
    )
    expectSyncConflict(() =>
      resolveBotTurnWorkTargetToWorkerStart(
        { worktree: 'id:wt-different' },
        existingPlacement,
        false
      )
    )
    expectSyncConflict(() =>
      resolveBotTurnWorkTargetToWorkerStart(
        { repo: 'id:repo-acme-local', worktree: 'id:wt-auth' },
        existingPlacement,
        false
      )
    )
    expectSyncConflict(() =>
      resolveBotTurnWorkTargetToWorkerStart(
        { origin: 'bot-item:item-1', worktree: 'current' },
        pairedProjectPlacement,
        false
      )
    )

    // Untargeted turns preserve explicit destinations, terminal reuse, and follow-ups untouched.
    expect(
      resolveBotTurnWorkTargetToWorkerStart(
        { repo: 'id:repo-other', worktree: 'new-top-level', on: 'env-other' },
        undefined,
        false
      )
    ).toEqual({
      params: { repo: 'id:repo-other', worktree: 'new-top-level', on: 'env-other' }
    })
    expect(
      resolveBotTurnWorkTargetToWorkerStart({ terminal: 'term-existing' }, undefined, true)
    ).toEqual({
      params: { terminal: 'term-existing' }
    })
  })

  it('refuses conflicting worker-start flags, unverified terminal reuse, and prior-project worker follow-ups across real local and paired paths with zero side effects', async () => {
    const { runtime, db, botHomeFolder } = await createPlacementRuntimeFixture()
    const botHomeKey = folderWorkspaceKey(botHomeFolder.id)
    const botCaller = makeBotCaller('sess-bot-1', botHomeKey)

    const createWorktreeSpy = vi.spyOn(runtime, 'createManagedWorktree')
    const createTerminalSpy = vi.spyOn(runtime, 'createTerminal')
    const resolveServerSpy = vi
      .spyOn(runtime, 'resolveOrchestrationWorkerServer')
      .mockImplementation(async (selector) => {
        if (selector !== 'env-build' && selector !== 'Build Server') {
          throw new Error('server_not_found')
        }
        return {
          environmentId: 'env-build',
          name: 'Build Server',
          pairingRevision: 7,
          peerFingerprint: 'fp-build-v7'
        }
      })
    const remoteCallSpy = vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({})
    const workerStartMethod = eraseRpcMethods(ORCHESTRATION_WORKER_START_METHODS)[0]!

    const assertZeroEffectsRefusal = async (run: () => Promise<unknown>) => {
      const runsBefore = db.listRuns().runs.length
      const terminalsBefore = createTerminalSpy.mock.calls.length
      const worktreeCallsBefore = createWorktreeSpy.mock.calls.length
      const remoteCallsBefore = remoteCallSpy.mock.calls.length
      await expect(run()).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof OrchestrationError &&
          error.code === 'invalid_argument' &&
          typeof error.data === 'object' &&
          error.data !== null &&
          'effectsApplied' in error.data &&
          error.data.effectsApplied === false
      )
      expect(db.listRuns().runs.length).toBe(runsBefore)
      expect(createTerminalSpy.mock.calls.length).toBe(terminalsBefore)
      expect(createWorktreeSpy.mock.calls.length).toBe(worktreeCallsBefore)
      expect(remoteCallSpy.mock.calls.length).toBe(remoteCallsBefore)
    }

    // 1) Local project target active -> conflicting repo/worktree/on/terminal and prior-project follow-up fail with zero effects.
    runtime.botWorkTargets.setForTurn('sess-bot-1', {
      mode: 'new-top-level',
      repoSelector: 'id:repo-acme-local',
      targetHostId: 'local',
      canonicalTarget: {
        kind: 'project',
        hostId: 'local',
        repoId: 'repo-acme-local',
        repoKind: 'git',
        displayName: 'acme-api'
      }
    })
    await assertZeroEffectsRefusal(() =>
      startWorker(
        {
          from: 'term_bot',
          spec: 'Wrong repo attempt',
          repo: 'id:repo-other-project',
          worktree: 'new-top-level',
          agent: 'codex'
        },
        { runtime, orchestrationCaller: botCaller }
      )
    )
    await assertZeroEffectsRefusal(() =>
      startWorker(
        {
          from: 'term_bot',
          spec: 'Wrong worktree mode attempt',
          repo: 'id:repo-acme-local',
          worktree: 'new-child',
          agent: 'codex'
        },
        { runtime, orchestrationCaller: botCaller }
      )
    )
    await assertZeroEffectsRefusal(() =>
      startWorker(
        {
          from: 'term_bot',
          spec: 'Reusing terminal from another project',
          terminal: 'term_other_project_worker'
        },
        { runtime, orchestrationCaller: botCaller }
      )
    )
    await assertZeroEffectsRefusal(() =>
      routeRemoteOwnedCall(
        runtime,
        workerStartMethod,
        {
          id: 'req-conflict-on',
          authToken: 'tok-test',
          method: 'orchestration.workerStart',
          params: {}
        },
        {
          from: 'term_bot',
          spec: 'Conflicting remote host',
          on: 'env-build',
          repo: 'id:remote-acme',
          worktree: 'new-top-level'
        },
        { runtime, orchestrationCaller: botCaller }
      )
    )
    expect(resolveServerSpy).not.toHaveBeenCalled()

    const followUpPlaceSpy = vi.fn(async () => ({
      delivery: 'follow_up' as const,
      worktreeId: 'repo-other-project::/synth/local/other-project',
      terminal: 'term_other_project_worker'
    }))
    await assertZeroEffectsRefusal(() =>
      startWorker(
        {
          from: 'term_bot',
          run: 'run_prior_project',
          spec: 'Follow up on prior worker in another project'
        },
        { runtime, orchestrationCaller: botCaller },
        {
          of: 'ctx_prior_other_project',
          addressed: 'ctx_prior_other_project',
          place: followUpPlaceSpy
        }
      )
    )
    expect(followUpPlaceSpy).not.toHaveBeenCalled()

    // 2) Paired-server project target active -> conflicting flags/terminal fail BEFORE resolving server;
    // compatible omitted --on binds to env-build and STILL enforces pairing revision before any remote RPC.
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
        hostLabel: 'Build Server',
        pairingRevision: 7,
        peerFingerprint: 'fp-build-v7'
      }
    })
    await assertZeroEffectsRefusal(() =>
      routeRemoteOwnedCall(
        runtime,
        workerStartMethod,
        {
          id: 'req-paired-conflict',
          authToken: 'tok-test',
          method: 'orchestration.workerStart',
          params: {}
        },
        {
          from: 'term_bot',
          spec: 'Wrong repo on paired server',
          on: 'env-build',
          repo: 'id:remote-other',
          worktree: 'new-top-level'
        },
        { runtime, orchestrationCaller: botCaller }
      )
    )
    await assertZeroEffectsRefusal(() =>
      routeRemoteOwnedCall(
        runtime,
        workerStartMethod,
        {
          id: 'req-paired-term',
          authToken: 'tok-test',
          method: 'orchestration.workerStart',
          params: {}
        },
        {
          from: 'term_bot',
          spec: 'Terminal reuse during paired target',
          terminal: 'term_local_1'
        },
        { runtime, orchestrationCaller: botCaller }
      )
    )
    expect(resolveServerSpy).not.toHaveBeenCalled()

    resolveServerSpy.mockResolvedValueOnce({
      environmentId: 'env-build',
      name: 'Build Server',
      pairingRevision: 8,
      peerFingerprint: 'fp-build-v8'
    })
    await expect(
      routeRemoteOwnedCall(
        runtime,
        workerStartMethod,
        {
          id: 'req-paired-omit-on',
          authToken: 'tok-test',
          method: 'orchestration.workerStart',
          params: {}
        },
        {
          from: 'term_bot',
          spec: 'Omitted --on with matching repo',
          repo: 'id:remote-acme',
          worktree: 'new-top-level'
        },
        { runtime, orchestrationCaller: botCaller }
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof OrchestrationError && error.code === 'server_pairing_changed'
    )
    expect(remoteCallSpy).not.toHaveBeenCalled()

    // 3) Legacy federated startWorker path enforces the exact same paired identity and refuses stale peerFingerprint with zero RPCs.
    const runsBeforeFederated = db.listRuns().runs.length
    resolveServerSpy.mockResolvedValueOnce({
      environmentId: 'env-build',
      name: 'Build Server',
      pairingRevision: 7,
      peerFingerprint: 'fp-rebuilt-different-key'
    })
    await expect(
      startWorker(
        {
          from: 'term_bot',
          spec: 'Omitted --on through direct startWorker',
          repo: 'id:remote-acme',
          worktree: 'new-top-level',
          agent: 'codex'
        },
        {
          runtime,
          orchestrationCaller: botCaller,
          orchestrationMutation: {
            callerFingerprint: 'test-caller',
            requestId: 'req-fed-pin-1',
            method: 'orchestration.workerStart',
            payloadHash: 'hash-fed-pin-1'
          }
        }
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof OrchestrationError && error.code === 'server_pairing_changed'
    )
    expect(remoteCallSpy).not.toHaveBeenCalled()
    expect(db.listRuns().runs).toHaveLength(runsBeforeFederated)

    // 4) Existing workspace target active -> conflicting --repo/--worktree/--terminal fail closed with zero effects.
    runtime.botWorkTargets.setForTurn('sess-bot-1', {
      mode: 'existing',
      worktreeSelector: 'identity:wt2:local:inst-auth-1',
      targetHostId: 'local',
      expectedWorkspaceInstanceId: 'inst-auth-1',
      canonicalTarget: {
        kind: 'workspace',
        hostId: 'local',
        repoId: 'repo-acme-local',
        repoKind: 'git',
        workspaceId: 'wt-auth',
        workspaceInstanceId: 'inst-auth-1',
        workspaceKind: 'git-worktree',
        displayName: 'feat/auth-fix'
      }
    })
    await assertZeroEffectsRefusal(() =>
      startWorker(
        {
          from: 'term_bot',
          spec: 'Wrong existing worktree',
          worktree: 'id:wt-other',
          agent: 'codex'
        },
        { runtime, orchestrationCaller: botCaller }
      )
    )
    await assertZeroEffectsRefusal(() =>
      startWorker(
        {
          from: 'term_bot',
          spec: 'Passing --repo on existing workspace target',
          repo: 'id:repo-acme-local',
          worktree: 'id:wt-auth',
          agent: 'codex'
        },
        { runtime, orchestrationCaller: botCaller }
      )
    )
    await assertZeroEffectsRefusal(() =>
      startWorker(
        {
          from: 'term_bot',
          spec: 'Unverified terminal reuse on existing target',
          terminal: 'term_unverified_existing'
        },
        { runtime, orchestrationCaller: botCaller }
      )
    )
  })
})
