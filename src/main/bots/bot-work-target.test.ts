import { describe, expect, it, vi } from 'vitest'
import { BotSchema, type Bot } from '../../shared/bot-types'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project/groups/project-group-types'
import type { Repo } from '../../shared/repository/repo-types'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalWorkTarget } from '../../shared/agent-session/work-target/agent-session-work-target'
import type { NativeChatBlock } from '../../shared/native-chat/native-chat-types'
import type { AgentSessionHandoverContext } from '../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { StructuredAgentSessionInputNotAdmitted } from '../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import { structuredAgentSessionRideAlong } from '../native-chat/agent-session-wire/structured-agent-session-ride-along'
import { createBotMemoryRecord } from './bot-memory-record'
import { botStructuredSessionWiring } from './bot-structured-session-wiring'
import type { BotChatJournal } from './bot-turn-rows'
import {
  applyBotTurnWorkTargetToWorkerStart,
  BotTurnWorkTargetRegistry
} from './bot-turn-work-target'
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
    chatSessionId: 'sess-bot-1',
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

function blockText(block: NativeChatBlock | undefined): string {
  return block?.type === 'text' ? block.text : ''
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
    executionHostId: 'ssh:box-build'
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
  const workspaces = new Map<string, BotWorkTargetWorkspaceSummary>([
    [
      'id:wt-auth',
      {
        id: 'wt-auth',
        repoId: 'repo-acme-local',
        displayName: 'feat/auth-fix',
        branch: 'feat/auth-fix',
        path: '/synth/local/acme-api-auth',
        isArchived: false
      }
    ],
    [
      'id:wt-archived',
      {
        id: 'wt-archived',
        repoId: 'repo-acme-local',
        displayName: 'old-branch',
        branch: 'old-branch',
        path: '/synth/local/acme-api-old',
        isArchived: true
      }
    ],
    [
      'id:repo-notes::/synth/local/design-notes',
      {
        id: 'repo-notes::/synth/local/design-notes',
        repoId: 'repo-notes',
        displayName: 'design-notes',
        branch: '',
        path: '/synth/local/design-notes',
        isArchived: false
      }
    ],
    [
      'id:folder:fw-runbooks',
      {
        id: 'folder:fw-runbooks',
        repoId: '',
        displayName: 'runbooks',
        branch: '',
        path: '/synth/local/runbooks',
        isArchived: false
      }
    ]
  ])
  return {
    hostId: 'local',
    isBotHome: (workspaceId) => workspaceId === 'folder:fw-bot-home',
    botsRoot: () => '/synth/bots',
    getSshConnectionStatus: (targetId) => (targetId === 'box-build' ? 'connected' : 'disconnected'),
    store: () => ({
      getBots: () => [makeBot('bot-1', 'fw-bot-home')],
      getRepos: () => [localGitRepo, sshGitRepo, hiddenRepo, folderProjectRepo],
      getFolderWorkspaces: () => [botHome, userFolder, archivedFolder],
      getProjectGroups: () => [botGroup]
    }),
    showManagedTerminalWorkspace: async (selector) => {
      const found = workspaces.get(selector)
      if (!found) {
        throw new Error('selector_not_found')
      }
      return found
    },
    ...overrides
  }
}

describe('validateBotWorkTarget host policy and live placement resolution', () => {
  const botRecord = makeSessionLocation('folder:fw-bot-home', 'folder')

  it('refuses non-bot chats, hidden/deleted/archived/bot-home targets, and offline or unreachable hosts', async () => {
    const deps = makeDeps()

    const nonBot = await validateBotWorkTarget(
      deps,
      makeSessionLocation('wt-auth', 'git-worktree'),
      {
        kind: 'project',
        hostId: 'local',
        repoId: 'repo-acme-local',
        displayName: 'acme-api'
      }
    )
    expect(nonBot).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'workTargetUnsupportedChat' } }
    })

    const hidden = await validateBotWorkTarget(deps, botRecord, {
      kind: 'project',
      hostId: 'local',
      repoId: 'repo-secret',
      displayName: 'hidden-repo'
    })
    expect(hidden).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'workTargetUnavailable' } }
    })

    const archivedWt = await validateBotWorkTarget(deps, botRecord, {
      kind: 'workspace',
      hostId: 'local',
      repoId: 'repo-acme-local',
      workspaceId: 'wt-archived',
      displayName: 'old-branch'
    })
    expect(archivedWt).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'workTargetUnavailable' } }
    })

    const botHomeTarget = await validateBotWorkTarget(deps, botRecord, {
      kind: 'workspace',
      hostId: 'local',
      workspaceId: 'folder:fw-bot-home',
      workspaceKind: 'folder',
      displayName: 'HelperBot'
    })
    expect(botHomeTarget).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'workTargetUnavailable' } }
    })

    const archivedFolder = await validateBotWorkTarget(deps, botRecord, {
      kind: 'workspace',
      hostId: 'local',
      workspaceId: 'folder:fw-old',
      workspaceKind: 'folder',
      displayName: 'old-notes'
    })
    expect(archivedFolder).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'workTargetUnavailable' } }
    })

    const crossHostMismatch = await validateBotWorkTarget(deps, botRecord, {
      kind: 'project',
      hostId: 'local',
      repoId: 'repo-acme-ssh',
      displayName: 'acme-api'
    })
    expect(crossHostMismatch).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'workTargetUnavailable' } }
    })

    const offlineSsh = await validateBotWorkTarget(
      makeDeps({ getSshConnectionStatus: () => 'disconnected' }),
      botRecord,
      {
        kind: 'project',
        hostId: 'ssh:box-build',
        repoId: 'repo-acme-ssh',
        displayName: 'acme-api'
      }
    )
    expect(offlineSsh).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'workTargetHostUnavailable' } }
    })

    const remoteBotTargetingLocal = await validateBotWorkTarget(
      makeDeps({ hostId: 'runtime:env-remote' }),
      botRecord,
      {
        kind: 'project',
        hostId: 'local',
        repoId: 'repo-acme-local',
        displayName: 'acme-api'
      }
    )
    expect(remoteBotTargetingLocal).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'workTargetHostUnavailable' } }
    })
  })

  it('resolves Git project, Folder project, existing Git worktree, existing Folder workspace, and paired server targets', async () => {
    const deps = makeDeps({
      resolveOrchestrationWorkerServer: async (selector) => {
        if (selector !== 'env-build') {
          throw new Error('offline')
        }
        return { environmentId: 'env-build', name: 'Build Server', pairingRevision: 7 }
      },
      callOrchestrationWorkerServer: async (_envId, method) => {
        if (method === 'repo.list') {
          return {
            repos: [
              makeRepo({ id: 'remote-acme', displayName: 'acme-api', path: '/srv/acme-api' }),
              makeRepo({
                id: 'remote-hidden',
                displayName: 'secret',
                path: '/srv/secret',
                hiddenAt: 100
              })
            ]
          }
        }
        return {}
      }
    })

    const gitProject = await validateBotWorkTarget(deps, botRecord, {
      kind: 'project',
      hostId: 'local',
      repoId: 'repo-acme-local',
      displayName: 'acme-api'
    })
    expect(gitProject).toEqual({
      ok: true,
      placement: {
        mode: 'new-child',
        repoSelector: 'id:repo-acme-local',
        canonicalTarget: {
          kind: 'project',
          hostId: 'local',
          repoId: 'repo-acme-local',
          repoKind: 'git',
          displayName: 'acme-api'
        }
      }
    })

    const sshSameNameProject = await validateBotWorkTarget(deps, botRecord, {
      kind: 'project',
      hostId: 'ssh:box-build',
      repoId: 'repo-acme-ssh',
      displayName: 'acme-api',
      hostLabel: 'Build SSH'
    })
    expect(sshSameNameProject).toMatchObject({
      ok: true,
      placement: {
        mode: 'new-child',
        repoSelector: 'id:repo-acme-ssh',
        canonicalTarget: { hostId: 'ssh:box-build', repoId: 'repo-acme-ssh' }
      }
    })

    const folderProject = await validateBotWorkTarget(deps, botRecord, {
      kind: 'project',
      hostId: 'local',
      repoId: 'repo-notes',
      repoKind: 'folder',
      displayName: 'design-notes'
    })
    expect(folderProject).toEqual({
      ok: true,
      placement: {
        mode: 'existing',
        worktreeSelector: 'id:repo-notes::/synth/local/design-notes',
        canonicalTarget: {
          kind: 'project',
          hostId: 'local',
          repoId: 'repo-notes',
          repoKind: 'folder',
          workspaceId: 'repo-notes::/synth/local/design-notes',
          workspaceKind: 'folder',
          displayName: 'design-notes'
        }
      }
    })

    const gitWorktree = await validateBotWorkTarget(deps, botRecord, {
      kind: 'workspace',
      hostId: 'local',
      repoId: 'repo-acme-local',
      workspaceId: 'wt-auth',
      workspaceKind: 'git-worktree',
      displayName: 'feat/auth-fix'
    })
    expect(gitWorktree).toEqual({
      ok: true,
      placement: {
        mode: 'existing',
        worktreeSelector: 'id:wt-auth',
        canonicalTarget: {
          kind: 'workspace',
          hostId: 'local',
          repoId: 'repo-acme-local',
          repoKind: 'git',
          workspaceId: 'wt-auth',
          workspaceKind: 'git-worktree',
          displayName: 'feat/auth-fix',
          projectName: 'acme-api'
        }
      }
    })

    const folderWorkspace = await validateBotWorkTarget(deps, botRecord, {
      kind: 'workspace',
      hostId: 'local',
      workspaceId: 'folder:fw-runbooks',
      workspaceKind: 'folder',
      displayName: 'runbooks'
    })
    expect(folderWorkspace).toEqual({
      ok: true,
      placement: {
        mode: 'existing',
        worktreeSelector: 'id:folder:fw-runbooks',
        canonicalTarget: {
          kind: 'workspace',
          hostId: 'local',
          workspaceId: 'folder:fw-runbooks',
          workspaceKind: 'folder',
          displayName: 'runbooks'
        }
      }
    })

    const pairedProject = await validateBotWorkTarget(deps, botRecord, {
      kind: 'project',
      hostId: 'runtime:env-build',
      repoId: 'remote-acme',
      displayName: 'acme-api'
    })
    expect(pairedProject).toEqual({
      ok: true,
      placement: {
        mode: 'new-child',
        repoSelector: 'id:remote-acme',
        onEnvironmentId: 'env-build',
        canonicalTarget: {
          kind: 'project',
          hostId: 'runtime:env-build',
          repoId: 'remote-acme',
          repoKind: 'git',
          displayName: 'acme-api',
          hostLabel: 'Build Server'
        }
      }
    })

    const pairedHidden = await validateBotWorkTarget(deps, botRecord, {
      kind: 'project',
      hostId: 'runtime:env-build',
      repoId: 'remote-hidden',
      displayName: 'secret'
    })
    expect(pairedHidden).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'workTargetUnavailable' } }
    })
  })
})

describe('bot handover re-validation, single-turn scope, and worker-start placement', () => {
  function makeWiring(options: {
    targetStillValid: () => boolean
    workTargets: BotTurnWorkTargetRegistry
  }) {
    const turnNote = vi.fn(async () => 'Previous worker note that would conflict')
    const handedOver = vi.fn()
    const turnEnded = vi.fn()
    const deps = makeDeps({
      showManagedTerminalWorkspace: async (selector) => {
        if (!options.targetStillValid()) {
          throw new Error('selector_not_found')
        }
        return makeDeps().showManagedTerminalWorkspace(selector)
      }
    })
    const memory = createBotMemoryRecord({
      readText: async () => null,
      replaceText: async () => true,
      writeText: async () => true
    })
    const chats: BotChatJournal = {
      sourcesAfter: async () => ({ owner: false, labels: [], places: [], urls: [] }),
      turnRanSince: async () => false
    }
    const wiring = botStructuredSessionWiring({
      store: () => ({
        getBots: () => [makeBot('bot-1', 'fw-bot-home')],
        getRepos: () => deps.store()!.getRepos()
      }),
      bots: {
        endFirstRun: async () => undefined,
        memory
      },
      chats,
      work: { turnNote, handedOver, turnEnded },
      lookAround: {
        botOfLook: () => null,
        botOfTidyUp: () => null,
        lookTurnIsQuiet: () => false
      },
      workTargets: options.workTargets,
      validateWorkTarget: (record, target) => validateBotWorkTarget(deps, record, target),
      sessionRecord: (sessionId) =>
        sessionId === 'sess-bot-1' ? makeSessionLocation('folder:fw-bot-home', 'folder') : null
    })
    return { wiring, turnNote, handedOver, turnEnded }
  }

  function makeJournalStub(): AgentSessionHandoverContext['journal'] {
    const stub = {
      reads: {
        automationResultNotes: async () => ({ items: [], submissions: [] })
      },
      appendItem: async () => ({
        itemId: 'item-1',
        sequence: 1,
        cursor: { epoch: 'e', sequence: 1 }
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ride-along only calls reads.automationResultNotes and appendItem.
    return stub as unknown as AgentSessionHandoverContext['journal']
  }

  const submission: AgentJournalSubmission = {
    clientMessageId: 'msg-1',
    fence: 1,
    payloadFingerprint: 'fp-1',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }

  it('rejects a queued message at handover without fallback when its target disappeared', async () => {
    let valid = true
    const workTargets = new BotTurnWorkTargetRegistry()
    const { wiring } = makeWiring({ targetStillValid: () => valid, workTargets })

    // Target disappears between enqueue and handover.
    valid = false
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Run tests in feat/auth-fix' }],
      workTarget: {
        kind: 'workspace',
        hostId: 'local',
        repoId: 'repo-acme-local',
        workspaceId: 'wt-auth',
        workspaceKind: 'git-worktree',
        displayName: 'feat/auth-fix'
      }
    }
    const rideAlong = structuredAgentSessionRideAlong(
      { sessionId: 'sess-bot-1', journal: makeJournalStub(), turnContext: wiring.turnContext },
      submission,
      body
    )

    await expect(rideAlong.claim(1, AGENT_JOURNAL_THREAD_SCOPE)).rejects.toBeInstanceOf(
      StructuredAgentSessionInputNotAdmitted
    )
    expect(workTargets.getForTurn('sess-bot-1')).toBeUndefined()
  })

  it('binds exact existing workspace and project targets to worker-start for one turn only, preserves leading /skills, and clears afterwards', async () => {
    const workTargets = new BotTurnWorkTargetRegistry()
    const { wiring, turnNote } = makeWiring({ targetStillValid: () => true, workTargets })

    const existingTarget: AgentJournalWorkTarget = {
      kind: 'workspace',
      hostId: 'local',
      repoId: 'repo-acme-local',
      workspaceId: 'wt-auth',
      workspaceKind: 'git-worktree',
      displayName: 'feat/auth-fix',
      projectName: 'acme-api'
    }
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Fix failing login test' }],
      workTarget: existingTarget
    }
    const rideAlong = structuredAgentSessionRideAlong(
      { sessionId: 'sess-bot-1', journal: makeJournalStub(), turnContext: wiring.turnContext },
      submission,
      body
    )
    await rideAlong.claim(1, AGENT_JOURNAL_THREAD_SCOPE)
    const outgoing = rideAlong.outgoing(body)

    // Conflicting prior-worker note was suppressed and <orca_context> points at the exact worktree ID.
    expect(turnNote).not.toHaveBeenCalled()
    expect(blockText(outgoing.blocks[0])).toContain('--worktree id:wt-auth')
    expect(blockText(outgoing.blocks[0])).toContain('Fix failing login test')

    // Default worker-start during this turn routes to the exact existing workspace instead of bot home.
    const placed = applyBotTurnWorkTargetToWorkerStart(
      { worktree: 'current', spec: 'Fix failing login test' },
      workTargets.getForTurn('sess-bot-1'),
      false
    )
    expect(placed).toEqual({
      worktree: 'id:wt-auth',
      spec: 'Fix failing login test'
    })

    // Explicit terminal or follow-up calls are respected without clobbering.
    const followUp = applyBotTurnWorkTargetToWorkerStart(
      { worktree: 'current', terminal: 'term-existing' },
      workTargets.getForTurn('sess-bot-1'),
      false
    )
    expect(followUp).toEqual({ worktree: 'current', terminal: 'term-existing' })

    // Turn end clears active placement so the next message never leaks the previous target.
    wiring.turnContext.turnEnded?.(
      'sess-bot-1',
      'turn-1',
      async () => ({ items: [], submissions: [], openerIds: new Map() }),
      async () => undefined
    )
    expect(workTargets.getForTurn('sess-bot-1')).toBeUndefined()

    // Leading slash skill message keeps /skill at block 0 and appends <orca_context> after it.
    const projectTarget: AgentJournalWorkTarget = {
      kind: 'project',
      hostId: 'local',
      repoId: 'repo-acme-local',
      repoKind: 'git',
      displayName: 'acme-api'
    }
    const skillBody: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: '/review check login flow' }],
      workTarget: projectTarget
    }
    const skillRideAlong = structuredAgentSessionRideAlong(
      { sessionId: 'sess-bot-1', journal: makeJournalStub(), turnContext: wiring.turnContext },
      submission,
      skillBody
    )
    await skillRideAlong.claim(2, AGENT_JOURNAL_THREAD_SCOPE)
    const skillOutgoing = skillRideAlong.outgoing(skillBody)
    expect(skillOutgoing.blocks[0]).toEqual({ type: 'text', text: '/review check login flow' })
    expect(blockText(skillOutgoing.blocks[1])).toContain(
      '--repo id:repo-acme-local --worktree new-child'
    )

    // Project target places worker-start into --repo id:<repoId> --worktree new-child.
    const placedProject = applyBotTurnWorkTargetToWorkerStart(
      { worktree: 'current', spec: 'Review login flow' },
      workTargets.getForTurn('sess-bot-1'),
      false
    )
    expect(placedProject).toEqual({
      repo: 'id:repo-acme-local',
      worktree: 'new-child',
      spec: 'Review login flow'
    })

    // Next untargeted message handover clears any lingering turn binding.
    wiring.turnContext.handedOver?.('sess-bot-1', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Regular question' }]
    })
    expect(workTargets.getForTurn('sess-bot-1')).toBeUndefined()
  })
})
