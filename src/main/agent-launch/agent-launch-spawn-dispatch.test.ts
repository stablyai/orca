import { describe, expect, it, vi } from 'vitest'
import { dispatchAgentLaunchSpawn } from './agent-launch-spawn-dispatch'
import type {
  AgentLaunchSpawnDeps,
  AgentLaunchSpawnInput,
  AgentLaunchSpawnTarget
} from './agent-launch-spawn'
import { AgentLaunchBoundary } from './agent-launch-boundary'
import {
  AgentLaunchAdmissionStore,
  LaunchAdmissionCoordinator
} from './agent-launch-admission-store'
import type { GlobalSettings } from '../../shared/types'
import type {
  ResolvedAgentLaunch,
  AgentLaunchSnapshot
} from '../../shared/agent-launch-host-contract'
import type { ResolveAgentLaunchOutcome } from './resolve-agent-launch'

function makeSnapshot(): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: 'claude',
    baseAgent: 'claude',
    displayLabel: 'Claude',
    mode: 'built-in',
    argv: ['/opt/resolved-claude', '--tui'],
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

function makeLaunch(): ResolvedAgentLaunch {
  const snapshot = makeSnapshot()
  return {
    requestedAgent: 'claude',
    baseAgent: 'claude',
    displayLabel: 'Claude',
    argv: snapshot.argv,
    agentEnv: snapshot.agentEnv,
    variables: { values: { repoPath: null, worktreePath: null }, referenced: [] },
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
    admissionGuard: { fingerprint: 'fp-1', stableInputDigest: 'sfp-1', basis: 'explicit' }
  }
}

const TARGET: AgentLaunchSpawnTarget = {
  platform: 'linux',
  shell: 'posix',
  isRemote: false,
  executionHostId: 'local',
  targetHomePath: '/home/dev'
}

function makeDeps(outcome: () => ResolveAgentLaunchOutcome): {
  deps: AgentLaunchSpawnDeps
  store: AgentLaunchAdmissionStore
  boundary: AgentLaunchBoundary
} {
  const store = new AgentLaunchAdmissionStore()
  const boundary = new AgentLaunchBoundary({
    admissionStore: store,
    coordinator: new LaunchAdmissionCoordinator()
  })
  return {
    store,
    boundary,
    deps: {
      getSettings: () => ({}) as GlobalSettings,
      getCatalogRevision: () => 5,
      boundary,
      resolve: () => outcome()
    }
  }
}

function baseInput(): AgentLaunchSpawnInput {
  return {
    request: { selection: { kind: 'agent', agent: 'claude' }, prompt: 'do the thing' },
    intent: { kind: 'interactive', client: 'desktop' },
    target: TARGET,
    variables: { repoPath: '/repo', worktreePath: '/repo/wt' },
    scope: 'worktree-1',
    principal: { kind: 'local' }
  }
}

describe('dispatchAgentLaunchSpawn', () => {
  it('spawns exactly one PTY from the resolved command and settles registered', async () => {
    const { deps, store } = makeDeps(() => ({ ok: true, launch: makeLaunch() }))
    const spawn = vi.fn(async (plan, token) => {
      // The plan command comes from host resolution, not any client input.
      expect(plan.launchCommand).toContain('/opt/resolved-claude')
      expect(token).toMatch(/.+/)
      return { id: 'pty-1' }
    })
    const result = await dispatchAgentLaunchSpawn({ deps, input: baseInput(), spawn })

    expect(result.ok).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1)
    if (result.ok) {
      expect(result.result).toEqual({ id: 'pty-1' })
      expect(result.receipt.launchToken).toBeTruthy()
    }
    // Registered settles the reservation (released from the pending store).
    expect(store.pendingCount()).toBe(0)
  })

  it('creates zero PTYs on a typed resolution failure', async () => {
    const { deps, store } = makeDeps(() => ({
      ok: false,
      failure: { code: 'base_agent_unavailable', baseAgent: 'claude' }
    }))
    const spawn = vi.fn(async () => ({ id: 'pty-x' }))
    const result = await dispatchAgentLaunchSpawn({ deps, input: baseInput(), spawn })

    expect(result).toEqual({
      ok: false,
      failure: { code: 'base_agent_unavailable', baseAgent: 'claude' }
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(store.pendingCount()).toBe(0)
  })

  it('settles failed and rethrows when the spawn executor throws', async () => {
    const { deps, store } = makeDeps(() => ({ ok: true, launch: makeLaunch() }))
    const spawn = vi.fn(async () => {
      throw new Error('spawn boom')
    })
    await expect(dispatchAgentLaunchSpawn({ deps, input: baseInput(), spawn })).rejects.toThrow(
      /spawn boom/
    )
    expect(spawn).toHaveBeenCalledTimes(1)
    // Failed releases the reservation entirely; no leaked pending record.
    expect(store.pendingCount()).toBe(0)
  })

  it('propagates a request error without spawning', async () => {
    const { deps } = makeDeps(() => ({
      ok: false,
      requestError: { code: 'untrusted_reference' }
    }))
    const spawn = vi.fn(async () => ({ id: 'pty-x' }))
    const result = await dispatchAgentLaunchSpawn({ deps, input: baseInput(), spawn })
    expect(result).toEqual({ ok: false, requestError: { code: 'untrusted_reference' } })
    expect(spawn).not.toHaveBeenCalled()
  })
})
