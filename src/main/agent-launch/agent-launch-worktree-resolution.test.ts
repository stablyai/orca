import { describe, expect, it, vi } from 'vitest'
import {
  prepareWorktreeAgentLaunch,
  executeWorktreeAgentLaunch,
  type WorktreeAgentLaunchContext,
  type WorktreeAgentLaunchDeps
} from './agent-launch-worktree-resolution'
import { AgentLaunchBoundary } from './agent-launch-boundary'
import {
  AgentLaunchAdmissionStore,
  LaunchAdmissionCoordinator,
  type AdmissionPrincipal
} from './agent-launch-admission-store'
import type { GlobalSettings } from '../../shared/types'
import type {
  ResolveAgentLaunchRequest,
  ResolvedAgentLaunch,
  AgentLaunchSnapshot
} from '../../shared/agent-launch-host-contract'
import type { ResolveAgentLaunchOutcome } from './resolve-agent-launch'

const LOCAL: AdmissionPrincipal = { kind: 'local' }

function makeSnapshot(): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: 'claude',
    baseAgent: 'claude',
    displayLabel: 'Claude',
    mode: 'built-in',
    argv: ['/opt/claude'],
    agentEnv: {},
    capturedEnvPolicy: 'none',
    target: {
      platform: 'linux',
      execution: 'native',
      shell: 'posix',
      isRemote: false,
      executionHostId: 'local'
    }
  }
}

function makeLaunch(
  fingerprint: string,
  stableInputDigest: string,
  worktreePath: string | null
): ResolvedAgentLaunch {
  const snapshot = makeSnapshot()
  return {
    requestedAgent: 'claude',
    baseAgent: 'claude',
    displayLabel: 'Claude',
    argv: snapshot.argv,
    agentEnv: snapshot.agentEnv,
    variables: {
      values: { repoPath: '/repo', worktreePath },
      referenced: ['worktreePath']
    },
    snapshot,
    policy: {
      intent: 'interactive',
      mode: 'built-in',
      client: 'desktop',
      isRemote: false,
      platform: 'linux',
      promptInjectionMode: 'stdin-after-start',
      expectedProcess: 'claude',
      env: 'none'
    },
    notices: [],
    telemetry: { agentKind: 'claude-code', usedCustomAgent: false },
    admissionGuard: { fingerprint, stableInputDigest, basis: 'default' }
  }
}

function makeSetup(resolve: (request: ResolveAgentLaunchRequest) => ResolveAgentLaunchOutcome): {
  deps: WorktreeAgentLaunchDeps
  store: AgentLaunchAdmissionStore
} {
  const store = new AgentLaunchAdmissionStore()
  const boundary = new AgentLaunchBoundary({
    admissionStore: store,
    coordinator: new LaunchAdmissionCoordinator(),
    now: () => 1000
  })
  const deps: WorktreeAgentLaunchDeps = {
    boundary,
    getSettings: () => ({}) as GlobalSettings,
    getCatalogRevision: () => 5,
    detectStockBaseAgents: async () => null,
    resolveTargetHomePath: async () => '/home/dev',
    resolve: (request) => resolve(request)
  }
  return { deps, store }
}

const CONTEXT: WorktreeAgentLaunchContext = {
  request: { selection: { kind: 'default' }, allowEmptyPromptLaunch: true },
  intent: { kind: 'interactive', client: 'desktop' },
  descriptor: { kind: 'local', platform: 'linux', shell: 'posix' },
  scope: 'wt-op',
  principal: LOCAL
}

describe('two-stage worktree agent-launch resolution', () => {
  it('keeps default-agent detection valid when settings change during the host probe', async () => {
    const claudeId = 'custom-agent:claude:01234567-89ab-4cde-8f01-23456789abcd' as const
    const codexId = 'custom-agent:codex:12345678-9abc-4def-8012-3456789abcde' as const
    const customTuiAgents = [
      {
        id: claudeId,
        baseAgent: 'claude' as const,
        label: 'Claude Review',
        args: '',
        env: {},
        syncEnv: false
      },
      {
        id: codexId,
        baseAgent: 'codex' as const,
        label: 'Codex Review',
        args: '',
        env: {},
        syncEnv: false
      }
    ]
    let settings = {
      agentCatalogRevision: 1,
      defaultTuiAgent: claudeId,
      customTuiAgents
    } as unknown as GlobalSettings
    const { deps } = makeSetup(() => ({
      ok: false,
      failure: { code: 'base_agent_unavailable', baseAgent: 'codex' }
    }))
    deps.getSettings = () => settings
    delete deps.resolve
    const detect = vi.fn(
      async (_descriptor, baseAgents?: readonly string[]): Promise<readonly string[]> => {
        settings = {
          agentCatalogRevision: 2,
          defaultTuiAgent: codexId,
          customTuiAgents
        } as unknown as GlobalSettings
        return baseAgents ?? ['claude', 'codex']
      }
    )
    deps.detectStockBaseAgents = detect

    const prepared = await prepareWorktreeAgentLaunch(deps, CONTEXT, {
      repoPath: '/repo',
      worktreePath: '/wt-provisional'
    })

    expect(detect).toHaveBeenCalledWith(CONTEXT.descriptor)
    expect(prepared.ok).toBe(true)
    if (prepared.ok) {
      expect(prepared.requestedAgent).toBe(codexId)
    }
  })

  it('pins the config digest pre-git and admits it post-git across a changed path', async () => {
    const resolve = vi
      .fn<(request: ResolveAgentLaunchRequest) => ResolveAgentLaunchOutcome>()
      .mockReturnValueOnce({
        ok: true,
        launch: makeLaunch('fp-prov', 'sd-1', '/wt-provisional')
      })
      .mockReturnValueOnce({
        ok: true,
        launch: makeLaunch('fp-real', 'sd-1', '/wt-real')
      })
      .mockReturnValueOnce({
        ok: true,
        launch: makeLaunch('fp-real', 'sd-1', '/wt-real')
      })
    const { deps, store } = makeSetup(resolve)

    const prepared = await prepareWorktreeAgentLaunch(deps, CONTEXT, {
      repoPath: '/repo',
      worktreePath: '/wt-provisional'
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) {
      return
    }
    expect(prepared.stableInputDigest).toBe('sd-1')
    expect(prepared.requestedAgent).toBe('claude')
    // The hold counts before commit; nothing is admitted yet.
    expect(store.pendingForPrincipal(LOCAL)).toBe(1)
    expect(store.pendingCount()).toBe(0)

    const executed = await executeWorktreeAgentLaunch(
      deps,
      CONTEXT,
      { repoPath: '/repo', worktreePath: '/wt-real' },
      {
        reservationId: prepared.reservationId,
        expectedStableInputDigest: prepared.stableInputDigest
      }
    )
    expect(executed.ok).toBe(true)
    if (!executed.ok) {
      return
    }
    // The reservation converted into exactly one admitted token; no double-count.
    expect(store.pendingForPrincipal(LOCAL)).toBe(1)
    expect(store.get(executed.receipt.launchToken)?.snapshot.requestedAgent).toBe('claude')
    // Final resolution ran against the authoritative worktree path.
    expect(resolve.mock.calls[1]![0].variables.worktreePath).toBe('/wt-real')
  })

  it('releases the reservation and reports a config change when the digest moved', async () => {
    const resolve = vi
      .fn<(request: ResolveAgentLaunchRequest) => ResolveAgentLaunchOutcome>()
      .mockReturnValueOnce({
        ok: true,
        launch: makeLaunch('fp-prov', 'sd-1', '/wt-provisional')
      })
      .mockReturnValueOnce({
        ok: true,
        launch: makeLaunch('fp-real', 'sd-2', '/wt-real')
      })
    const { deps, store } = makeSetup(resolve)

    const prepared = await prepareWorktreeAgentLaunch(deps, CONTEXT, {
      repoPath: '/repo',
      worktreePath: '/wt-provisional'
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) {
      return
    }

    const executed = await executeWorktreeAgentLaunch(
      deps,
      CONTEXT,
      { repoPath: '/repo', worktreePath: '/wt-real' },
      {
        reservationId: prepared.reservationId,
        expectedStableInputDigest: prepared.stableInputDigest
      }
    )
    expect(executed.ok).toBe(false)
    if (executed.ok) {
      return
    }
    expect('failure' in executed && executed.failure.code).toBe('agent_configuration_changed')
    // A rejected two-stage launch never permanently burns capacity.
    expect(store.pendingForPrincipal(LOCAL)).toBe(0)
    expect(store.pendingCount()).toBe(0)
  })

  it('threads the stage-2 worktree into admission so the per-worktree cap counts it (L3-#3)', async () => {
    const resolve = vi
      .fn<(request: ResolveAgentLaunchRequest) => ResolveAgentLaunchOutcome>()
      .mockReturnValue({
        ok: true,
        launch: makeLaunch('fp-real', 'sd-1', '/wt-real')
      })
    const { deps, store } = makeSetup(resolve)
    const prepared = await prepareWorktreeAgentLaunch(deps, CONTEXT, {
      repoPath: '/repo',
      worktreePath: '/wt-provisional'
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) {
      return
    }
    const executed = await executeWorktreeAgentLaunch(
      deps,
      { ...CONTEXT, worktreeId: 'wt-created' },
      { repoPath: '/repo', worktreePath: '/wt-real' },
      {
        reservationId: prepared.reservationId,
        expectedStableInputDigest: 'sd-1'
      }
    )
    expect(executed.ok).toBe(true)
    expect(store.pendingForWorktree('wt-created')).toBe(1)
  })

  it("defaults the admission worktree to a background intent's own worktree (L3-#3)", async () => {
    const resolve = vi
      .fn<(request: ResolveAgentLaunchRequest) => ResolveAgentLaunchOutcome>()
      .mockReturnValue({
        ok: true,
        launch: makeLaunch('fp-real', 'sd-1', '/wt-real')
      })
    const { deps, store } = makeSetup(resolve)
    const context: WorktreeAgentLaunchContext = {
      ...CONTEXT,
      intent: {
        kind: 'background',
        attemptId: 'attempt-1',
        worktreeId: 'wt-bg'
      },
      scope: 'attempt-1'
    }
    const prepared = await prepareWorktreeAgentLaunch(deps, context, {
      repoPath: '/repo',
      worktreePath: '/wt-real'
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) {
      return
    }
    const executed = await executeWorktreeAgentLaunch(
      deps,
      context,
      { repoPath: '/repo', worktreePath: '/wt-real' },
      {
        reservationId: prepared.reservationId,
        expectedStableInputDigest: 'sd-1'
      }
    )
    expect(executed.ok).toBe(true)
    // Scope is the attempt id, yet the cap counts the attempt's worktree.
    expect(store.pendingForWorktree('wt-bg')).toBe(1)
    expect(store.pendingForWorktree('attempt-1')).toBe(0)
  })

  it('frees the hold when a stage-2 host read rejects, so repeated races keep capacity', async () => {
    const resolve = vi
      .fn<(request: ResolveAgentLaunchRequest) => ResolveAgentLaunchOutcome>()
      .mockReturnValue({
        ok: true,
        launch: makeLaunch('fp-real', 'sd-1', '/wt-real')
      })
    const { deps, store } = makeSetup(resolve)

    // More rounds than MAX_PENDING_LAUNCHES_PER_PRINCIPAL: a leaked hold per round
    // exhausts the principal's capacity until restart.
    for (let round = 0; round < 70; round++) {
      deps.resolveTargetHomePath = async () => '/home/dev'
      const prepared = await prepareWorktreeAgentLaunch(deps, CONTEXT, {
        repoPath: '/repo',
        worktreePath: '/wt-provisional'
      })
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) {
        return
      }
      // The SSH connection drops between git creating the worktree and stage 2.
      deps.resolveTargetHomePath = async () => {
        throw new Error('ssh channel closed')
      }
      const executed = await executeWorktreeAgentLaunch(
        deps,
        CONTEXT,
        { repoPath: '/repo', worktreePath: '/wt-real' },
        {
          reservationId: prepared.reservationId,
          expectedStableInputDigest: 'sd-1'
        }
      )
      expect(executed.ok).toBe(false)
      if (executed.ok) {
        return
      }
      expect('failure' in executed && executed.failure.code).toBe('spawn_failed')
      expect(store.pendingForPrincipal(LOCAL)).toBe(0)
      expect(store.pendingCount()).toBe(0)
    }
  })

  it('takes no reservation when pre-git resolution fails', async () => {
    const resolve = vi
      .fn<(request: ResolveAgentLaunchRequest) => ResolveAgentLaunchOutcome>()
      .mockReturnValueOnce({
        ok: false,
        failure: { code: 'custom_agent_disabled' }
      })
    const { deps, store } = makeSetup(resolve)

    const prepared = await prepareWorktreeAgentLaunch(deps, CONTEXT, {
      repoPath: '/repo',
      worktreePath: '/wt-provisional'
    })
    expect(prepared.ok).toBe(false)
    expect(store.pendingForPrincipal(LOCAL)).toBe(0)
  })
})
