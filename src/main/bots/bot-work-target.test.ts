import { describe, expect, it, vi } from 'vitest'
import { BotSchema, type Bot } from '../../shared/bot-types'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project/groups/project-group-types'
import type { Repo } from '../../shared/repository/repo-types'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { createWorktreeIdentity } from '../../shared/worktree/identity'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { admitSendWorkTarget } from '../native-chat/agent-session-wire/operations/structured-agent-session-send-preparation'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import {
  validateBotWorkTarget,
  type BotWorkTargetValidationDeps,
  type BotWorkTargetWorkspaceSummary
} from './bot-work-target-validation'

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'displayName' | 'path'>): Repo {
  return {
    badgeColor: '',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function makeFolderWorkspace(
  overrides: Partial<FolderWorkspace> & Pick<FolderWorkspace, 'id' | 'name' | 'folderPath'>
): FolderWorkspace {
  return {
    projectGroupId: 'grp-ops',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeProjectGroup(
  overrides: Partial<ProjectGroup> & Pick<ProjectGroup, 'id' | 'name'>
): ProjectGroup {
  return {
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeBot(id: string, folderWorkspaceId: string): Bot {
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
    chatSessionId: SESSION,
    createdAt: 1,
    updatedAt: 1
  })
}

function makeSessionLocation(
  workspaceId: string,
  workspaceKind: 'folder' | 'git-worktree' = 'folder'
): Pick<AgentSessionRecord, 'location'> {
  return {
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId,
      workspaceKind
    }
  }
}

function makeWorkspace(
  overrides: Partial<BotWorkTargetWorkspaceSummary> &
    Pick<BotWorkTargetWorkspaceSummary, 'id' | 'repoId' | 'displayName' | 'path'>
): BotWorkTargetWorkspaceSummary {
  const hostId = overrides.hostId ?? 'local'
  const instanceId = overrides.instanceId
  return {
    branch: overrides.displayName,
    isArchived: false,
    hostId,
    ...(instanceId
      ? {
          instanceId,
          identity: createWorktreeIdentity({
            worktreeId: overrides.id,
            executionHostId: hostId,
            instanceId
          })
        }
      : {}),
    ...overrides
  }
}

function makeDeps(
  overrides: Partial<BotWorkTargetValidationDeps> = {}
): BotWorkTargetValidationDeps {
  const localGitRepo = makeRepo({
    id: 'repo-acme-local',
    displayName: 'acme-api',
    path: '/synth/local/acme-api',
    executionHostId: 'local'
  })
  const sshGitRepo = makeRepo({
    id: 'repo-acme-ssh',
    displayName: 'acme-api',
    path: '/srv/ssh/acme-api',
    executionHostId: 'ssh:box-build',
    connectionId: 'box-build'
  })
  const twinLocalRepo = makeRepo({
    id: 'repo-twin',
    displayName: 'shared-svc',
    path: '/synth/local/shared-svc',
    executionHostId: 'local'
  })
  const twinSshRepo = makeRepo({
    id: 'repo-twin',
    displayName: 'shared-svc',
    path: '/srv/ssh/shared-svc',
    executionHostId: 'ssh:box-build',
    connectionId: 'box-build'
  })
  const hiddenRepo = makeRepo({
    id: 'repo-secret',
    displayName: 'hidden-repo',
    path: '/synth/local/hidden-repo',
    executionHostId: 'local',
    hiddenAt: 100
  })
  const folderProjectRepo = makeRepo({
    id: 'repo-notes',
    displayName: 'design-notes',
    path: '/synth/local/design-notes',
    kind: 'folder',
    executionHostId: 'local'
  })
  const sshFolderProjectRepo = makeRepo({
    id: 'repo-ssh-notes',
    displayName: 'remote-notes',
    path: '/srv/ssh/remote-notes',
    kind: 'folder',
    executionHostId: 'ssh:box-build',
    connectionId: 'box-build'
  })
  const botHome = makeFolderWorkspace({
    id: 'fw-bot-home',
    name: 'HelperBot',
    folderPath: '/synth/bots/helper',
    projectGroupId: 'grp-bots'
  })
  const userFolder = makeFolderWorkspace({
    id: 'fw-runbooks',
    name: 'runbooks',
    folderPath: '/synth/local/runbooks',
    projectGroupId: 'grp-ops'
  })
  const sshFolder = makeFolderWorkspace({
    id: 'fw-ssh-ops',
    name: 'ssh-ops',
    folderPath: '/srv/ssh/ops',
    executionHostId: 'ssh:box-build',
    connectionId: 'box-build',
    projectGroupId: 'grp-ops'
  })
  const archivedFolder = makeFolderWorkspace({
    id: 'fw-old',
    name: 'old-notes',
    folderPath: '/synth/local/old-notes',
    isArchived: true
  })
  const botGroup = makeProjectGroup({
    id: 'grp-bots',
    name: 'Bots',
    parentPath: '/synth/bots'
  })
  const workspacesByHost = new Map<string, BotWorkTargetWorkspaceSummary>([
    [
      'local\0id:wt-auth',
      makeWorkspace({
        id: 'wt-auth',
        repoId: 'repo-acme-local',
        hostId: 'local',
        instanceId: 'inst-auth-1',
        displayName: 'feat/auth-fix',
        branch: 'feat/auth-fix',
        path: '/synth/local/acme-api-auth'
      })
    ],
    [
      'ssh:box-build\0id:wt-ssh-main',
      makeWorkspace({
        id: 'wt-ssh-main',
        repoId: 'repo-acme-ssh',
        hostId: 'ssh:box-build',
        instanceId: 'inst-ssh-main',
        displayName: 'main',
        branch: 'main',
        path: '/srv/ssh/acme-api'
      })
    ],
    [
      'local\0id:repo-twin::/shared/wt',
      makeWorkspace({
        id: 'repo-twin::/shared/wt',
        repoId: 'repo-twin',
        hostId: 'local',
        instanceId: 'inst-twin-local',
        displayName: 'twin-local',
        path: '/shared/wt'
      })
    ],
    [
      'ssh:box-build\0id:repo-twin::/shared/wt',
      makeWorkspace({
        id: 'repo-twin::/shared/wt',
        repoId: 'repo-twin',
        hostId: 'ssh:box-build',
        instanceId: 'inst-twin-ssh',
        displayName: 'twin-ssh',
        path: '/shared/wt'
      })
    ],
    [
      'local\0id:wt-archived',
      makeWorkspace({
        id: 'wt-archived',
        repoId: 'repo-acme-local',
        hostId: 'local',
        instanceId: 'inst-archived',
        displayName: 'old-branch',
        path: '/synth/local/acme-api-old',
        isArchived: true
      })
    ],
    [
      'local\0id:repo-notes::/synth/local/design-notes',
      makeWorkspace({
        id: 'repo-notes::/synth/local/design-notes',
        repoId: 'repo-notes',
        hostId: 'local',
        instanceId: 'inst-notes-1',
        displayName: 'design-notes',
        branch: '',
        path: '/synth/local/design-notes'
      })
    ],
    [
      'ssh:box-build\0id:repo-ssh-notes::/srv/ssh/remote-notes',
      makeWorkspace({
        id: 'repo-ssh-notes::/srv/ssh/remote-notes',
        repoId: 'repo-ssh-notes',
        hostId: 'ssh:box-build',
        instanceId: 'inst-ssh-notes-1',
        displayName: 'remote-notes',
        branch: '',
        path: '/srv/ssh/remote-notes'
      })
    ],
    [
      'local\0id:folder:fw-runbooks',
      makeWorkspace({
        id: 'folder:fw-runbooks',
        repoId: '',
        hostId: 'local',
        displayName: 'runbooks',
        branch: '',
        path: '/synth/local/runbooks'
      })
    ],
    [
      'ssh:box-build\0id:folder:fw-ssh-ops',
      makeWorkspace({
        id: 'folder:fw-ssh-ops',
        repoId: '',
        hostId: 'ssh:box-build',
        displayName: 'ssh-ops',
        branch: '',
        path: '/srv/ssh/ops'
      })
    ]
  ])
  return {
    hostId: 'local',
    isBotHome: (workspaceId) => workspaceId === 'folder:fw-bot-home',
    botsRoot: () => '/synth/bots',
    getSshConnectionStatus: (targetId) => (targetId === 'box-build' ? 'connected' : 'disconnected'),
    store: () => ({
      getBots: () => [makeBot('bot-1', 'fw-bot-home')],
      getRepos: () => [
        localGitRepo,
        sshGitRepo,
        twinLocalRepo,
        twinSshRepo,
        hiddenRepo,
        folderProjectRepo,
        sshFolderProjectRepo
      ],
      getProjectHostSetups: () => [
        {
          id: 'setup-1',
          projectId: 'proj-acme',
          hostId: 'local',
          repoId: 'repo-acme-local',
          displayName: 'acme-api',
          path: '/synth/local/acme-api',
          setupState: 'ready',
          setupMethod: 'imported-existing-folder',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      getFolderWorkspaces: () => [botHome, userFolder, sshFolder, archivedFolder],
      getProjectGroups: () => [botGroup]
    }),
    showManagedTerminalWorkspace: async (selector, requiredHostId) => {
      const key = `${requiredHostId ?? 'local'}\0${selector}`
      const found = workspacesByHost.get(key)
      if (!found) {
        throw new Error('selector_not_found')
      }
      return found
    },
    ...overrides
  }
}

describe('validateBotWorkTarget host policy, SSH launch boundaries, and exact identity', () => {
  const botRecord = makeSessionLocation('folder:fw-bot-home', 'folder')

  it('refuses non-bot chats, hidden/archived/bot-home targets, offline/unregistered SSH, connected SSH Git projects, stale explicit repoId, and recreated worktree occupants', async () => {
    const deps = makeDeps()

    expect(
      await validateBotWorkTarget(deps, makeSessionLocation('wt-auth', 'git-worktree'), {
        kind: 'project',
        hostId: 'local',
        repoId: 'repo-acme-local',
        displayName: 'acme-api'
      })
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'workTargetUnsupportedChat' } } })

    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'project',
        hostId: 'local',
        repoId: 'repo-secret',
        displayName: 'hidden-repo'
      })
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'workTargetUnavailable' } } })

    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'workspace',
        hostId: 'local',
        repoId: 'repo-acme-local',
        workspaceId: 'wt-archived',
        displayName: 'old-branch'
      })
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'workTargetUnavailable' } } })

    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'workspace',
        hostId: 'local',
        workspaceId: 'folder:fw-bot-home',
        workspaceKind: 'folder',
        displayName: 'HelperBot'
      })
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'workTargetUnavailable' } } })

    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'workspace',
        hostId: 'local',
        workspaceId: 'folder:fw-old',
        workspaceKind: 'folder',
        displayName: 'old-notes'
      })
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'workTargetUnavailable' } } })

    // Connected SSH Git project is rejected at admission because runtime createManagedWorktree throws SshHostNotServedError.
    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'project',
        hostId: 'ssh:box-build',
        repoId: 'repo-acme-ssh',
        displayName: 'acme-api',
        hostLabel: 'Build SSH'
      })
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'workTargetUnavailable' } } })

    // Unregistered/disconnected SSH host is refused as host-unavailable.
    expect(
      await validateBotWorkTarget(
        makeDeps({ getSshConnectionStatus: () => undefined }),
        botRecord,
        {
          kind: 'workspace',
          hostId: 'ssh:box-build',
          repoId: 'repo-acme-ssh',
          workspaceId: 'wt-ssh-main',
          displayName: 'main'
        }
      )
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'workTargetHostUnavailable' } } })

    // Stale explicit repoId must never fall back via projectId to another repo on the same host.
    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'project',
        hostId: 'local',
        projectId: 'proj-acme',
        repoId: 'repo-deleted-explicit',
        displayName: 'acme-api'
      })
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'workTargetUnavailable' } } })

    // Delete + recreate at the exact same worktree path (new instanceId) must fail closed.
    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'workspace',
        hostId: 'local',
        repoId: 'repo-acme-local',
        workspaceId: 'wt-auth',
        workspaceInstanceId: 'inst-auth-deleted',
        workspaceKind: 'git-worktree',
        displayName: 'feat/auth-fix'
      })
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'workTargetUnavailable' } } })

    expect(
      await validateBotWorkTarget(makeDeps({ hostId: 'runtime:env-remote' }), botRecord, {
        kind: 'project',
        hostId: 'local',
        repoId: 'repo-acme-local',
        displayName: 'acme-api'
      })
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'workTargetHostUnavailable' } } })
  })

  it('admits local Git project as new-top-level, preserves connected SSH existing workspaces & host-twins with identity selectors, and pins paired-server pairing revision', async () => {
    const deps = makeDeps({
      resolveOrchestrationWorkerServer: async (selector) => {
        if (selector !== 'env-build') {
          throw new Error('offline')
        }
        return {
          environmentId: 'env-build',
          name: 'Build Server',
          pairingRevision: 7,
          peerFingerprint: 'fp-build-v7'
        }
      },
      callOrchestrationWorkerServer: async (_envId, method) => {
        if (method === 'repo.list') {
          return {
            repos: [
              makeRepo({ id: 'remote-acme', displayName: 'acme-api', path: '/srv/acme-api' }),
              makeRepo({
                id: 'remote-ssh',
                displayName: 'nested-ssh',
                path: '/srv/nested',
                executionHostId: 'ssh:nested',
                connectionId: 'nested'
              })
            ]
          }
        }
        if (method === 'worktree.list') {
          return {
            worktrees: [
              makeWorkspace({
                id: 'remote-acme::/srv/acme-auth',
                repoId: 'remote-acme',
                hostId: 'local',
                instanceId: 'inst-remote-auth',
                displayName: 'feat/remote-auth',
                path: '/srv/acme-auth'
              })
            ]
          }
        }
        return {}
      }
    })

    // Local Git project uses new-top-level with host scoping.
    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'project',
        hostId: 'local',
        repoId: 'repo-acme-local',
        displayName: 'acme-api'
      })
    ).toEqual({
      ok: true,
      placement: {
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
      }
    })

    // Connected SSH existing Git worktree, SSH folder project, and SSH folder workspace stay supported.
    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'workspace',
        hostId: 'ssh:box-build',
        repoId: 'repo-acme-ssh',
        workspaceId: 'wt-ssh-main',
        workspaceInstanceId: 'inst-ssh-main',
        workspaceKind: 'git-worktree',
        displayName: 'main',
        hostLabel: 'Build SSH'
      })
    ).toMatchObject({
      ok: true,
      placement: {
        mode: 'existing',
        targetHostId: 'ssh:box-build',
        expectedWorkspaceInstanceId: 'inst-ssh-main',
        worktreeSelector: 'identity:wt2:ssh%3Abox-build:inst-ssh-main'
      }
    })

    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'project',
        hostId: 'ssh:box-build',
        repoId: 'repo-ssh-notes',
        repoKind: 'folder',
        displayName: 'remote-notes'
      })
    ).toMatchObject({
      ok: true,
      placement: {
        mode: 'existing',
        targetHostId: 'ssh:box-build',
        worktreeSelector: 'identity:wt2:ssh%3Abox-build:inst-ssh-notes-1'
      }
    })

    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'workspace',
        hostId: 'ssh:box-build',
        workspaceId: 'folder:fw-ssh-ops',
        workspaceKind: 'folder',
        displayName: 'ssh-ops'
      })
    ).toMatchObject({
      ok: true,
      placement: {
        mode: 'existing',
        targetHostId: 'ssh:box-build',
        worktreeSelector: 'id:folder:fw-ssh-ops'
      }
    })

    // Host-twin workspaces sharing the exact same repoId and worktreeId resolve strictly to their chosen host.
    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'workspace',
        hostId: 'ssh:box-build',
        repoId: 'repo-twin',
        workspaceId: 'repo-twin::/shared/wt',
        workspaceInstanceId: 'inst-twin-ssh',
        workspaceKind: 'git-worktree',
        displayName: 'twin-ssh'
      })
    ).toMatchObject({
      ok: true,
      placement: {
        targetHostId: 'ssh:box-build',
        expectedWorkspaceInstanceId: 'inst-twin-ssh',
        worktreeSelector: 'identity:wt2:ssh%3Abox-build:inst-twin-ssh'
      }
    })

    // Paired server Git project retains host-authored pairingRevision + peerFingerprint on both placement and canonicalTarget.
    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'project',
        hostId: 'runtime:env-build',
        repoId: 'remote-acme',
        displayName: 'acme-api'
      })
    ).toEqual({
      ok: true,
      placement: {
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
      }
    })

    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'project',
        hostId: 'runtime:env-build',
        projectId: 'remote-acme',
        repoId: 'remote-deleted-explicit',
        displayName: 'acme-api'
      })
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'workTargetUnavailable' } } })

    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'workspace',
        hostId: 'runtime:env-build',
        repoId: 'remote-acme',
        workspaceId: 'remote-acme::/srv/acme-auth',
        workspaceInstanceId: 'inst-remote-auth',
        workspaceKind: 'git-worktree',
        displayName: 'feat/remote-auth'
      })
    ).toMatchObject({
      ok: true,
      placement: {
        mode: 'existing',
        worktreeSelector: 'identity:wt2:local:inst-remote-auth',
        expectedWorkspaceInstanceId: 'inst-remote-auth',
        onEnvironmentId: 'env-build',
        onExpectedPairingRevision: 7,
        onExpectedPeerFingerprint: 'fp-build-v7',
        canonicalTarget: {
          pairingRevision: 7,
          peerFingerprint: 'fp-build-v7'
        }
      }
    })
  })

  it('rejects paired-server handover when pinned revision/fingerprint changed with zero RPC calls, strips untrusted client pins at admission, and maps mid-flight pairing change to workTargetExpired', async () => {
    let currentPairingRevision = 7
    let currentPeerFingerprint = 'fp-build-v7'
    let throwMidFlightPairingChange = false
    const remoteCallSpy = vi.fn(async (_envId: string, method: string) => {
      if (throwMidFlightPairingChange) {
        throw new OrchestrationError('runtime_environment_changed', 'Pairing changed mid-flight')
      }
      if (method === 'repo.list') {
        return {
          repos: [makeRepo({ id: 'remote-acme', displayName: 'acme-api', path: '/srv/acme-api' })]
        }
      }
      return {}
    })
    const deps = makeDeps({
      resolveOrchestrationWorkerServer: async (selector) => {
        if (selector !== 'env-build') {
          throw new Error('offline')
        }
        return {
          environmentId: 'env-build',
          name: 'Build Server',
          pairingRevision: currentPairingRevision,
          peerFingerprint: currentPeerFingerprint
        }
      },
      callOrchestrationWorkerServer: remoteCallSpy
    })

    // Admission strips forged client-supplied pairing pins and writes the host-authored identity instead.
    const admitted = await admitSendWorkTarget(
      { validateWorkTarget: (record, target) => validateBotWorkTarget(deps, record, target) },
      botRecord,
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Deploy' }],
        workTarget: {
          kind: 'project',
          hostId: 'runtime:env-build',
          repoId: 'remote-acme',
          displayName: 'acme-api',
          pairingRevision: 999,
          peerFingerprint: 'fp-forged-by-renderer'
        }
      }
    )
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) {
      throw new Error('expected admission to succeed using host live state')
    }
    expect(admitted.body.workTarget).toMatchObject({
      hostId: 'runtime:env-build',
      repoId: 'remote-acme',
      pairingRevision: 7,
      peerFingerprint: 'fp-build-v7'
    })
    expect(remoteCallSpy).toHaveBeenCalledTimes(1)

    // Handover after pairingRevision bump refuses immediately with ZERO calls to the replacement server.
    remoteCallSpy.mockClear()
    currentPairingRevision = 8
    expect(await validateBotWorkTarget(deps, botRecord, admitted.body.workTarget!)).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'workTargetExpired' } }
    })
    expect(remoteCallSpy).not.toHaveBeenCalled()

    // Handover after peerFingerprint replacement (even with unchanged revision) refuses with ZERO calls.
    currentPairingRevision = 7
    currentPeerFingerprint = 'fp-build-rebuilt-vm'
    expect(await validateBotWorkTarget(deps, botRecord, admitted.body.workTarget!)).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'workTargetExpired' } }
    })
    expect(remoteCallSpy).not.toHaveBeenCalled()

    // Mid-flight runtime_environment_changed during remote read also refuses with workTargetExpired.
    currentPeerFingerprint = 'fp-build-v7'
    throwMidFlightPairingChange = true
    expect(await validateBotWorkTarget(deps, botRecord, admitted.body.workTarget!)).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'workTargetExpired' } }
    })

    // Legacy journal record without pairing pins still validates against the live server and stamps its pin.
    throwMidFlightPairingChange = false
    remoteCallSpy.mockClear()
    expect(
      await validateBotWorkTarget(deps, botRecord, {
        kind: 'project',
        hostId: 'runtime:env-build',
        repoId: 'remote-acme',
        displayName: 'acme-api'
      })
    ).toMatchObject({
      ok: true,
      placement: {
        onExpectedPairingRevision: 7,
        onExpectedPeerFingerprint: 'fp-build-v7',
        canonicalTarget: { pairingRevision: 7, peerFingerprint: 'fp-build-v7' }
      }
    })
    expect(remoteCallSpy).toHaveBeenCalledTimes(1)
  })
})
