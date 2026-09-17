import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'
import { collectRuntimeWorktreePtyAgentSources } from '../runtime/runtime-worktree-pty-agent-sources'
import { attachRuntimeWorktreeAgentRows } from '../runtime/runtime-worktree-agent-rows'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import type { AgentStatusLaunchBinding } from '../../shared/agent-status-launch-membership'
import { makePaneKey } from '../../shared/stable-pane-id'
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import { createAgentStatusExecutionBindingResolver } from './agent-status-execution-binding-resolver'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const binding: AgentStatusLaunchBinding = {
  runId: 'run-1',
  attachment: { executionId: 'execution-1' },
  role: 'root'
}
const remotePane = makePaneKey('tab-remote', '22222222-2222-4222-8222-222222222222')
const remoteBinding: AgentStatusLaunchBinding = {
  runId: 'run-remote',
  attachment: { executionId: 'execution-remote' },
  role: 'root'
}
const owner = {
  claim: {
    digestVersion: 1 as const,
    keyId: 'key',
    identityDigest: 'a'.repeat(43),
    worktreeScopeDigest: 'b'.repeat(43),
    agent: 'codex' as const
  },
  generation: 'generation-1',
  phase: 'live' as const,
  ptyId: 'pty-owner',
  surface: {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: '11111111-1111-4111-8111-111111111111',
    terminalHandle: `term_${'a'.repeat(32)}`
  },
  statusBinding: binding
}

beforeEach(() => {
  _internals.resetCachesForTests()
  getCohortAtEmitMock.mockReturnValue({})
  trackMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('host-owned launch membership', () => {
  it('ignores a bare create-operation result without an owner status binding', () => {
    const server = new AgentHookServer()
    expect(
      server.admitAgentSessionOwner({
        owner: { id: 'pty-only', incarnationId: 'incarnation-only' },
        paneKey: PANE,
        connectionId: null,
        terminalHandle: 'term-only',
        agentType: 'codex',
        disposition: 'created'
      })
    ).toBeNull()
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('publishes a compatibility row before the first provider observation', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.subscribeEnrichedStatus(listener)

    const admitted = server.admitAgentLaunch({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      terminalHandle: 'term_launch',
      agentType: 'codex',
      launchToken: 'launch-secret',
      binding,
      disposition: 'created',
      committedAt: 100
    })

    expect(admitted).toMatchObject({
      paneKey: PANE,
      payload: { state: 'done', sessionBoundary: true, agentType: 'codex' },
      launchMembership: { binding, phase: 'committed', disposition: 'created' }
    })
    expect(listener).toHaveBeenCalledOnce()
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      sessionBoundary: true,
      launchMembership: { binding, phase: 'committed' }
    })
  })

  it('carries membership through a provider event without treating it as turn state', () => {
    const server = new AgentHookServer()
    server.admitAgentLaunch({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: 'conn-1',
      terminalHandle: 'term_launch',
      agentType: 'codex',
      binding,
      disposition: 'created',
      committedAt: 100
    })
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: { state: 'working', prompt: 'hello', agentType: 'codex' }
      },
      'conn-1'
    )

    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      launchMembership: { binding, phase: 'committed' }
    })
  })

  it('keeps a hook that arrives during owner promotion and attaches membership after commit', async () => {
    const owners = new ClaimedAgentPtyOwnerRegistry()
    const launchOwner = {
      ...owner,
      ptyId: 'pty-reserved',
      surface: { ...owner.surface, terminalHandle: 'term_reserved' }
    }
    let pendingBinding: AgentStatusLaunchBinding | undefined
    let finishSpawn!: (result: { ptyId: string }) => void
    const ensure = owners.ensure({
      claim: launchOwner.claim,
      surface: launchOwner.surface,
      spawn: async ({ statusBinding }) => {
        pendingBinding = statusBinding
        return new Promise<{ ptyId: string }>((resolve) => {
          finishSpawn = resolve
        })
      }
    })
    await Promise.resolve()
    const bindingDuringPromotion = pendingBinding
    if (!bindingDuringPromotion) {
      throw new Error('expected reservation binding')
    }
    const server = new AgentHookServer()
    server.setExecutionBindingResolver(createAgentStatusExecutionBindingResolver(owners))
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: launchOwner.surface.tabId,
      worktreeId: launchOwner.surface.worktreeId,
      terminalHandle: launchOwner.surface.terminalHandle,
      reportedExecutionBinding: {
        runId: bindingDuringPromotion.runId,
        executionId: bindingDuringPromotion.attachment.executionId
      },
      payload: { state: 'working', prompt: 'first hook', agentType: 'codex' }
    })

    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      runId: bindingDuringPromotion.runId,
      executionId: bindingDuringPromotion.attachment.executionId
    })
    finishSpawn({ ptyId: launchOwner.ptyId })
    const committed = await ensure
    expect(
      server.admitAgentSessionOwner({
        owner: committed.owner,
        paneKey: PANE,
        tabId: launchOwner.surface.tabId,
        worktreeId: launchOwner.surface.worktreeId,
        connectionId: null,
        terminalHandle: launchOwner.surface.terminalHandle,
        agentType: 'codex',
        disposition: committed.disposition
      })
    ).toMatchObject({ payload: { state: 'working' }, launchMembership: { phase: 'committed' } })
  })

  it('retires failed launches and permits dismissal even when persistence fails', () => {
    const server = new AgentHookServer()
    server.admitAgentLaunch({
      paneKey: PANE,
      connectionId: null,
      terminalHandle: 'term_launch',
      agentType: 'codex',
      binding,
      disposition: 'created',
      committedAt: 100
    })
    expect(server.settleAgentLaunch(PANE, 'failed')).toBe(true)
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('does not retire rows for an incomplete owner census', () => {
    const server = new AgentHookServer()
    server.admitAgentLaunch({
      paneKey: PANE,
      connectionId: null,
      terminalHandle: 'term_launch',
      agentType: 'codex',
      binding,
      disposition: 'created',
      committedAt: 100
    })

    expect(server.reconcileAgentLaunchMembership([], { complete: false })).toEqual({
      reAdmitted: 0,
      retired: 0
    })
    expect(server.getStatusSnapshot()).toHaveLength(1)
    expect(server.getStatusSnapshot()[0]?.launchMembership?.phase).toBe('committed')
  })

  it('reconciles only the execution host covered by a targeted inventory', () => {
    const server = new AgentHookServer()
    server.admitAgentLaunch({
      paneKey: PANE,
      connectionId: null,
      terminalHandle: 'term-local',
      agentType: 'codex',
      binding,
      disposition: 'created',
      committedAt: 100
    })
    server.admitAgentLaunch({
      paneKey: remotePane,
      connectionId: 'conn-remote',
      terminalHandle: 'term-remote',
      agentType: 'codex',
      binding: remoteBinding,
      disposition: 'created',
      committedAt: 100
    })

    expect(
      server.reconcileAgentLaunchMembership([], { complete: true, connectionId: 'conn-remote' })
    ).toEqual({ reAdmitted: 0, retired: 1 })
    expect(server.getStatusSnapshot().map((entry) => entry.paneKey)).toEqual([PANE])
    expect(
      server.reconcileAgentLaunchMembership([], { complete: true, connectionId: null })
    ).toEqual({ reAdmitted: 0, retired: 1 })
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('drops launch membership when dismissal retains only provider resume identity', () => {
    const server = new AgentHookServer()
    server.admitAgentLaunch({
      paneKey: PANE,
      connectionId: null,
      terminalHandle: 'term-launch',
      agentType: 'codex',
      binding,
      disposition: 'created',
      committedAt: 100
    })
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        providerSession: { key: 'session_id', id: 'resume-me' },
        payload: { state: 'working', prompt: 'continue', agentType: 'codex' }
      },
      null
    )

    server.dropStatusEntry(PANE)
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      providerSessionOnly: true,
      providerSession: { key: 'session_id', id: 'resume-me' }
    })
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('launchMembership')
  })

  it('marks a hydrated launch unconfirmed and re-admits only matching owners', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-launch-membership-'))
    try {
      const first = new AgentHookServer()
      await first.start({ userDataPath, env: 'production' })
      first.admitAgentLaunch({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: null,
        terminalHandle: 'term_launch',
        agentType: 'codex',
        binding,
        disposition: 'created',
        committedAt: Date.now()
      })
      first.flushStatusPersistSync()
      first.stop()

      const second = new AgentHookServer()
      await second.start({ userDataPath, env: 'production' })
      expect(second.getStatusSnapshot()[0]?.launchMembership?.phase).toBe('unconfirmed')
      expect(second.reconcileAgentLaunchMembership([owner])).toEqual({
        reAdmitted: 1,
        retired: 0
      })
      expect(second.getStatusSnapshot()[0]?.launchMembership?.phase).toBe('committed')
      expect(second.getStatusSnapshot()[0]).toMatchObject({
        terminalHandle: owner.surface.terminalHandle,
        tabId: owner.surface.tabId,
        worktreeId: owner.surface.worktreeId
      })
      second.stop()

      const third = new AgentHookServer()
      await third.start({ userDataPath, env: 'production' })
      expect(third.reconcileAgentLaunchMembership([], { complete: true })).toEqual({
        reAdmitted: 0,
        retired: 1
      })
      expect(third.getStatusSnapshot()).toEqual([])
      third.stop()
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})

describe('launch membership worktree projection', () => {
  it('shows host activity without permission or working rollups', () => {
    const server = new AgentHookServer()
    server.admitAgentLaunch({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      terminalHandle: 'term_launch',
      agentType: 'codex',
      binding,
      disposition: 'created',
      committedAt: Date.now()
    })
    const sources = collectRuntimeWorktreePtyAgentSources({
      hookSnapshots: server.getStatusSnapshot(),
      mirroredWorktreeIdByTabId: new Map([['tab-1', 'wt-1']]),
      connectedPtyEvidence: {
        tabIds: new Set(),
        paneKeys: new Set(),
        ptyIdByTerminalHandle: new Map()
      }
    })
    const summary: RuntimeWorktreePsSummary = {
      worktreeId: 'wt-1',
      repoId: 'repo-1',
      repo: 'repo',
      path: '/tmp/repo',
      branch: 'main',
      isArchived: false,
      isMainWorktree: true,
      hasHostSidebarActivity: false,
      parentWorktreeId: null,
      childWorktreeIds: [],
      displayName: 'repo',
      workspaceStatus: 'clean',
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
    attachRuntimeWorktreeAgentRows({
      summaries: new Map([['wt-1', summary]]),
      pathIndex: {
        platformByRepoId: new Map(),
        posixAbsolute: new Map(),
        posixRelative: new Map(),
        windows: new Map(),
        windowsAbsolute: new Map()
      },
      missingWorktreeIds: new Set(),
      rowSources: new Map(sources.map((source) => [source.paneKey, source])),
      workingTerminalEvidenceByWorktreeId: new Map(),
      orchestrationByPaneKey: undefined,
      getSummary: (summaries, _pathIndex, _missing, worktreeId) => summaries.get(worktreeId) ?? null
    })
    expect(summary.hasHostSidebarActivity).toBe(true)
    expect(summary.status).toBe('inactive')
    expect(summary.agents[0]?.launchMembership).toMatchObject({ phase: 'committed' })
  })
})
