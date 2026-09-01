import { describe, expect, it, vi } from 'vitest'
import {
  AgentLaunchBoundary,
  mapClientKindToLaunchClient,
  type HostStateResolution
} from './agent-launch-boundary'
import {
  AgentLaunchAdmissionStore,
  LaunchAdmissionCoordinator,
  MAX_PENDING_LAUNCHES_PER_PRINCIPAL,
  type AdmissionPrincipal
} from './agent-launch-admission-store'
import type {
  ResolvedAgentLaunch,
  AgentLaunchSnapshot
} from '../../shared/agent-launch-host-contract'
import type { ResolveAgentLaunchOutcome } from './resolve-agent-launch'

const LOCAL_PRINCIPAL: AdmissionPrincipal = { kind: 'local' }

function makeSnapshot(overrides: Partial<AgentLaunchSnapshot> = {}): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: 'claude',
    baseAgent: 'claude',
    displayLabel: 'Claude',
    mode: 'built-in',
    argv: ['/bin/secretexe', '--flag'],
    agentEnv: { SECRET_ENV: 'topsecret-value' },
    capturedEnvPolicy: 'full',
    target: {
      platform: 'linux',
      execution: 'native',
      shell: 'posix',
      isRemote: false,
      executionHostId: 'local'
    },
    ...overrides
  }
}

function makeLaunch(
  fingerprint: string,
  overrides: Partial<ResolvedAgentLaunch> = {}
): ResolvedAgentLaunch {
  const snapshot = overrides.snapshot ?? makeSnapshot()
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
      env: 'full'
    },
    notices: [],
    telemetry: { agentKind: 'claude-code', usedCustomAgent: false },
    admissionGuard: { fingerprint, stableInputDigest: fingerprint, basis: 'explicit' },
    ...overrides
  }
}

function okResolution(launch: ResolvedAgentLaunch, catalogRevision = 1): HostStateResolution {
  return { outcome: { ok: true, launch }, catalogRevision }
}

function failureResolution(
  outcome: Extract<ResolveAgentLaunchOutcome, { ok: false }>,
  catalogRevision = 1
): HostStateResolution {
  return { outcome, catalogRevision }
}

function makeBoundary(): {
  boundary: AgentLaunchBoundary
  store: AgentLaunchAdmissionStore
} {
  const store = new AgentLaunchAdmissionStore()
  const boundary = new AgentLaunchBoundary({
    admissionStore: store,
    coordinator: new LaunchAdmissionCoordinator(),
    now: () => 1000
  })
  return { boundary, store }
}

describe('mapClientKindToLaunchClient', () => {
  it('maps runtime to paired-web, mobile to mobile, undefined to desktop', () => {
    expect(mapClientKindToLaunchClient('runtime')).toBe('paired-web')
    expect(mapClientKindToLaunchClient('mobile')).toBe('mobile')
    expect(mapClientKindToLaunchClient(undefined)).toBe('desktop')
  })
})

describe('AgentLaunchBoundary.executeAgentLaunch', () => {
  it('resolves for the plan once and admits the original snapshot', async () => {
    const { boundary, store } = makeBoundary()
    const original = makeLaunch('fp-1')
    // Second resolve returns a distinct launch object with the SAME fingerprint
    // (an unrelated catalog edit). The admitted snapshot must be the original.
    const reResolveLaunch = makeLaunch('fp-1', {
      snapshot: makeSnapshot({ displayLabel: 'edited' })
    })
    const resolve = vi
      .fn<() => HostStateResolution>()
      .mockReturnValueOnce(okResolution(original))
      .mockReturnValueOnce(okResolution(reResolveLaunch, 2))

    const result = await boundary.executeAgentLaunch({
      scope: 'worktree-1',
      principal: LOCAL_PRINCIPAL,
      resolve,
      prompt: '',
      allowEmptyPromptLaunch: true
    })

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const admitted = store.get(result.receipt.launchToken)
    expect(admitted?.snapshot).toBe(original.snapshot)
    expect(result.receipt.catalogRevision).toBe(2)
  })

  it('never serializes snapshot argv/env, fingerprint, or digest into the launched receipt', async () => {
    const { boundary } = makeBoundary()
    const launch = makeLaunch('fp-secret', {
      admissionGuard: {
        fingerprint: 'fp-secret',
        stableInputDigest: 'digest-secret',
        basis: 'explicit'
      }
    })

    const result = await boundary.executeAgentLaunch({
      scope: 'worktree-secret',
      principal: LOCAL_PRINCIPAL,
      resolve: () => okResolution(launch),
      prompt: '',
      allowEmptyPromptLaunch: true
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    // The receipt is the ONLY agent-launch payload that crosses to clients, so it
    // must carry the client-safe identity/notices/token only — never the host-
    // private snapshot argv/env, the relevant-input fingerprint, or the digest.
    expect(Object.keys(result.receipt).sort()).toEqual([
      'baseAgent',
      'catalogRevision',
      'launchToken',
      'notices',
      'requestedAgent',
      'telemetry'
    ])
    // Oracle 17: the receipt's telemetry marker is client-safe — the base kind
    // enum and a boolean only, never the requested (possibly custom) id or label.
    expect(Object.keys(result.receipt.telemetry).sort()).toEqual(['agentKind', 'usedCustomAgent'])
    expect(typeof result.receipt.telemetry.usedCustomAgent).toBe('boolean')
    const serialized = JSON.stringify(result.receipt)
    expect(serialized).not.toContain('secretexe') // snapshot argv executable
    expect(serialized).not.toContain('topsecret-value') // snapshot agentEnv value
    expect(serialized).not.toContain('SECRET_ENV') // snapshot agentEnv key
    expect(serialized).not.toContain('fp-secret') // relevant-input fingerprint
    expect(serialized).not.toContain('digest-secret') // config-only digest
  })

  it('returns the initial failure without admitting', async () => {
    const { boundary, store } = makeBoundary()
    const resolve = vi.fn(() =>
      failureResolution({ ok: false, failure: { code: 'no_agent_selected' } })
    )
    const result = await boundary.executeAgentLaunch({
      scope: 's',
      principal: LOCAL_PRINCIPAL,
      resolve,
      prompt: 'hi'
    })
    expect(result).toEqual({ ok: false, failure: { code: 'no_agent_selected' } })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(store.pendingCount()).toBe(0)
  })

  it('returns an initial request error without admitting', async () => {
    const { boundary, store } = makeBoundary()
    const resolve = vi.fn(() =>
      failureResolution({ ok: false, requestError: { code: 'untrusted_reference' } })
    )
    const result = await boundary.executeAgentLaunch({
      scope: 's',
      principal: LOCAL_PRINCIPAL,
      resolve,
      prompt: 'hi'
    })
    expect(result).toEqual({ ok: false, requestError: { code: 'untrusted_reference' } })
    expect(store.pendingCount()).toBe(0)
  })

  it('maps a base disable that wins the admission race to base_agent_disabled with no reservation', async () => {
    const { boundary, store } = makeBoundary()
    const resolve = vi
      .fn<() => HostStateResolution>()
      .mockReturnValueOnce(okResolution(makeLaunch('fp-1')))
      // Mutation committed between resolve and admit: base is now disabled.
      .mockReturnValueOnce(
        failureResolution({
          ok: false,
          failure: { code: 'base_agent_disabled', baseAgent: 'claude' }
        })
      )

    const result = await boundary.executeAgentLaunch({
      scope: 's',
      principal: LOCAL_PRINCIPAL,
      resolve,
      prompt: 'hi'
    })

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect('failure' in result && result.failure.code).toBe('base_agent_disabled')
    expect(store.pendingCount()).toBe(0)
  })

  it('maps any other relevant change to agent_configuration_changed', async () => {
    const { boundary, store } = makeBoundary()
    const resolve = vi
      .fn<() => HostStateResolution>()
      .mockReturnValueOnce(okResolution(makeLaunch('fp-1')))
      // Different fingerprint: a relevant input changed (definition/default/env).
      .mockReturnValueOnce(okResolution(makeLaunch('fp-2')))

    const result = await boundary.executeAgentLaunch({
      scope: 's',
      principal: LOCAL_PRINCIPAL,
      resolve,
      prompt: 'hi'
    })

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect('failure' in result && result.failure.code).toBe('agent_configuration_changed')
    expect(store.pendingCount()).toBe(0)
  })

  it('proceeds when only an unrelated agent changed (fingerprint unchanged)', async () => {
    const { boundary, store } = makeBoundary()
    const resolve = vi
      .fn<() => HostStateResolution>()
      .mockReturnValueOnce(okResolution(makeLaunch('fp-1')))
      .mockReturnValueOnce(okResolution(makeLaunch('fp-1')))

    const result = await boundary.executeAgentLaunch({
      scope: 's',
      principal: LOCAL_PRINCIPAL,
      resolve,
      prompt: 'hi'
    })

    expect(result.ok).toBe(true)
    expect(store.pendingCount()).toBe(1)
  })

  it('fails trust_preflight_failed on a thrown preflight and admits nothing', async () => {
    const { boundary, store } = makeBoundary()
    const resolve = vi.fn(() => okResolution(makeLaunch('fp-1')))
    const preflight = vi.fn(() => {
      throw new Error('trust denied')
    })

    const result = await boundary.executeAgentLaunch({
      scope: 's',
      principal: LOCAL_PRINCIPAL,
      resolve,
      prompt: 'hi',
      preflight
    })

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect('failure' in result && result.failure.code).toBe('trust_preflight_failed')
    expect(preflight).toHaveBeenCalledTimes(1)
    // No re-resolve happened because we never entered the coordinator.
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(store.pendingCount()).toBe(0)
  })

  it('fails trust_preflight_failed on a thrown provider env preparation hook', async () => {
    const { boundary, store } = makeBoundary()
    const resolve = vi.fn(() => okResolution(makeLaunch('fp-1')))
    const prepareEnv = vi.fn(async () => {
      throw new Error('env prep failed')
    })

    const result = await boundary.executeAgentLaunch({
      scope: 's',
      principal: LOCAL_PRINCIPAL,
      resolve,
      prompt: 'hi',
      prepareEnv
    })

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect('failure' in result && result.failure.code).toBe('trust_preflight_failed')
    expect(store.pendingCount()).toBe(0)
  })

  it('rejects with launch_capacity_exceeded before producing a plan', async () => {
    const { boundary, store } = makeBoundary()
    for (let index = 0; index < MAX_PENDING_LAUNCHES_PER_PRINCIPAL; index += 1) {
      store.admit({
        principal: LOCAL_PRINCIPAL,
        intent: 'interactive',
        scope: `filler-${index}`,
        worktreeId: null,
        fingerprint: 'x',
        snapshot: makeSnapshot(),
        admittedAt: 1
      })
    }
    const resolve = vi.fn(() => okResolution(makeLaunch('fp-1')))

    const result = await boundary.executeAgentLaunch({
      scope: 's',
      principal: LOCAL_PRINCIPAL,
      resolve,
      prompt: 'hi'
    })

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect('failure' in result && result.failure.code).toBe('launch_capacity_exceeded')
    expect('plan' in result).toBe(false)
  })

  it('produces a receipt free of argv, env, and snapshot material', async () => {
    const { boundary } = makeBoundary()
    const resolve = vi.fn(() => okResolution(makeLaunch('fp-1')))
    const result = await boundary.executeAgentLaunch({
      scope: 's',
      principal: LOCAL_PRINCIPAL,
      resolve,
      prompt: 'do the thing'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const serialized = JSON.stringify(result.receipt)
    expect(serialized).not.toContain('topsecret-value')
    expect(serialized).not.toContain('secretexe')
    expect(serialized).not.toContain('SECRET_ENV')
    expect(result.receipt.launchToken.length).toBeGreaterThan(0)
    // The plan carries the token; the receipt echoes it for the caller.
    expect(result.plan.launchToken).toBe(result.receipt.launchToken)
  })

  it('deduplicates receipt notices by code', async () => {
    const { boundary } = makeBoundary()
    const launch = makeLaunch('fp-1', {
      notices: [
        { code: 'env_withheld', label: 'Claude' },
        { code: 'env_withheld', label: 'Claude' },
        { code: 'snapshot_definition_changed', label: 'Claude' }
      ]
    })
    const resolve = vi.fn(() => okResolution(launch))
    const result = await boundary.executeAgentLaunch({
      scope: 's',
      principal: LOCAL_PRINCIPAL,
      resolve,
      prompt: 'hi'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.receipt.notices.map((notice) => notice.code)).toEqual([
      'env_withheld',
      'snapshot_definition_changed'
    ])
  })
})

describe('AgentLaunchBoundary.settleAgentLaunch', () => {
  it('registered retains a private handoff record and frees the reservation', async () => {
    const { boundary, store } = makeBoundary()
    const resolve = vi.fn(() => okResolution(makeLaunch('fp-1')))
    const result = await boundary.executeAgentLaunch({
      scope: 'worktree-9',
      principal: LOCAL_PRINCIPAL,
      resolve,
      prompt: 'hi'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const token = result.receipt.launchToken
    boundary.settleAgentLaunch(token, 'registered')
    expect(store.get(token)).toBeNull()
    expect(store.pendingForPrincipal(LOCAL_PRINCIPAL)).toBe(0)
    expect(boundary.retainedFor(token)?.scope).toBe('worktree-9')
  })

  it('failed releases the reservation and retains nothing', async () => {
    const { boundary, store } = makeBoundary()
    const resolve = vi.fn(() => okResolution(makeLaunch('fp-1')))
    const result = await boundary.executeAgentLaunch({
      scope: 'worktree-9',
      principal: LOCAL_PRINCIPAL,
      resolve,
      prompt: 'hi'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const token = result.receipt.launchToken
    boundary.settleAgentLaunch(token, 'failed')
    expect(store.get(token)).toBeNull()
    expect(store.pendingForPrincipal(LOCAL_PRINCIPAL)).toBe(0)
    expect(boundary.retainedFor(token)).toBeNull()
  })
})

describe('AgentLaunchBoundary.resolveAgentLaunchPlanWithoutAdmission', () => {
  it('resolves once and builds a plan without an admission token or capacity hold', () => {
    const { boundary, store } = makeBoundary()
    const resolve = vi
      .fn<() => HostStateResolution>()
      .mockReturnValue(okResolution(makeLaunch('fp-1')))

    const result = boundary.resolveAgentLaunchPlanWithoutAdmission({
      resolve,
      prompt: '',
      allowEmptyPromptLaunch: true
    })

    // The legacy path resolves exactly once — no coordinator re-resolve — and
    // never admits: the plan carries no launchToken and no capacity is held.
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.plan.launchToken).toBeUndefined()
    // All capacity is still free: nothing was reserved or admitted.
    for (let i = 0; i < MAX_PENDING_LAUNCHES_PER_PRINCIPAL; i++) {
      expect(store.reserve(LOCAL_PRINCIPAL).ok).toBe(true)
    }
  })

  it('returns the resolver failure without holding capacity', () => {
    const { boundary, store } = makeBoundary()
    const resolve = vi
      .fn<() => HostStateResolution>()
      .mockReturnValue(failureResolution({ ok: false, failure: { code: 'base_agent_disabled' } }))

    const result = boundary.resolveAgentLaunchPlanWithoutAdmission({ resolve, prompt: 'hi' })

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: false, failure: { code: 'base_agent_disabled' } })
    for (let i = 0; i < MAX_PENDING_LAUNCHES_PER_PRINCIPAL; i++) {
      expect(store.reserve(LOCAL_PRINCIPAL).ok).toBe(true)
    }
  })

  it('passes through a request-error resolution', () => {
    const { boundary } = makeBoundary()
    const result = boundary.resolveAgentLaunchPlanWithoutAdmission({
      resolve: () =>
        failureResolution({ ok: false, requestError: { code: 'stale_agent_launch_failure' } }),
      prompt: 'hi'
    })
    expect(result).toEqual({
      ok: false,
      requestError: { code: 'stale_agent_launch_failure' }
    })
  })
})

describe('AgentLaunchBoundary two-stage reserved launch', () => {
  function digestLaunch(fingerprint: string, stableInputDigest: string): ResolvedAgentLaunch {
    return makeLaunch(fingerprint, {
      admissionGuard: { fingerprint, stableInputDigest, basis: 'explicit' }
    })
  }

  function prepareHold(
    boundary: AgentLaunchBoundary,
    launch: ResolvedAgentLaunch
  ): { reservationId: string; stableInputDigest: string } {
    const prepared = boundary.prepareReservedAgentLaunch({
      principal: LOCAL_PRINCIPAL,
      resolve: () => okResolution(launch)
    })
    if (!prepared.ok) {
      throw new Error('expected prepare to succeed')
    }
    return { reservationId: prepared.reservationId, stableInputDigest: prepared.stableInputDigest }
  }

  it('prepare pins identity + digest and holds one reservation before git', () => {
    const { boundary, store } = makeBoundary()
    const prepared = boundary.prepareReservedAgentLaunch({
      principal: LOCAL_PRINCIPAL,
      resolve: () => okResolution(digestLaunch('fp-1', 'stable-A'))
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) {
      return
    }
    expect(prepared.requestedAgent).toBe('claude')
    expect(prepared.stableInputDigest).toBe('stable-A')
    // The hold counts toward capacity but is not a committed token yet.
    expect(store.pendingForPrincipal(LOCAL_PRINCIPAL)).toBe(1)
    expect(store.pendingCount()).toBe(0)
  })

  it('prepare takes no reservation when the pin resolve fails', () => {
    const { boundary, store } = makeBoundary()
    const prepared = boundary.prepareReservedAgentLaunch({
      principal: LOCAL_PRINCIPAL,
      resolve: () => failureResolution({ ok: false, failure: { code: 'no_agent_selected' } })
    })
    expect(prepared.ok).toBe(false)
    expect(store.pendingForPrincipal(LOCAL_PRINCIPAL)).toBe(0)
  })

  it('prepare rejects launch_capacity_exceeded without leaking a hold', () => {
    const { boundary, store } = makeBoundary()
    for (let index = 0; index < MAX_PENDING_LAUNCHES_PER_PRINCIPAL; index += 1) {
      store.reserve(LOCAL_PRINCIPAL)
    }
    const prepared = boundary.prepareReservedAgentLaunch({
      principal: LOCAL_PRINCIPAL,
      resolve: () => okResolution(makeLaunch('fp-1'))
    })
    expect(prepared.ok).toBe(false)
    if (prepared.ok) {
      return
    }
    expect('failure' in prepared && prepared.failure.code).toBe('launch_capacity_exceeded')
    expect(store.pendingForPrincipal(LOCAL_PRINCIPAL)).toBe(MAX_PENDING_LAUNCHES_PER_PRINCIPAL)
  })

  it('executeReserved converts the hold to exactly one token on success', async () => {
    const { boundary, store } = makeBoundary()
    const launch = digestLaunch('fp-1', 'stable-A')
    const { reservationId, stableInputDigest } = prepareHold(boundary, launch)
    const result = await boundary.executeReservedAgentLaunch({
      scope: 'wt-1',
      principal: LOCAL_PRINCIPAL,
      resolve: () => okResolution(launch),
      prompt: 'hi',
      reservationId,
      expectedStableInputDigest: stableInputDigest
    })
    expect(result.ok).toBe(true)
    // Converted, not double-counted: one committed record, no dangling hold.
    expect(store.pendingForPrincipal(LOCAL_PRINCIPAL)).toBe(1)
    expect(store.pendingCount()).toBe(1)
    if (result.ok) {
      expect(store.get(result.receipt.launchToken)?.snapshot).toBe(launch.snapshot)
    }
  })

  it('executeReserved releases the hold when the post-create config digest differs', async () => {
    const { boundary, store } = makeBoundary()
    const { reservationId } = prepareHold(boundary, digestLaunch('fp-1', 'stable-A'))
    const resolve = vi.fn(() => okResolution(digestLaunch('fp-2', 'stable-B')))
    const result = await boundary.executeReservedAgentLaunch({
      scope: 'wt-1',
      principal: LOCAL_PRINCIPAL,
      resolve,
      prompt: 'hi',
      reservationId,
      expectedStableInputDigest: 'stable-A'
    })
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect('failure' in result && result.failure.code).toBe('agent_configuration_changed')
    // Hold released, no capacity leaked; rejected before entering the coordinator.
    expect(store.pendingForPrincipal(LOCAL_PRINCIPAL)).toBe(0)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('executeReserved releases the hold when the post-create resolve fails', async () => {
    const { boundary, store } = makeBoundary()
    const { reservationId } = prepareHold(boundary, digestLaunch('fp-1', 'stable-A'))
    const result = await boundary.executeReservedAgentLaunch({
      scope: 'wt-1',
      principal: LOCAL_PRINCIPAL,
      resolve: () =>
        failureResolution({
          ok: false,
          failure: { code: 'missing_variable', variable: 'worktreePath' }
        }),
      prompt: 'hi',
      reservationId,
      expectedStableInputDigest: 'stable-A'
    })
    expect(result.ok).toBe(false)
    expect(store.pendingForPrincipal(LOCAL_PRINCIPAL)).toBe(0)
  })

  it('executeReserved releases the hold on a thrown preflight', async () => {
    const { boundary, store } = makeBoundary()
    const launch = digestLaunch('fp-1', 'stable-A')
    const { reservationId } = prepareHold(boundary, launch)
    const result = await boundary.executeReservedAgentLaunch({
      scope: 'wt-1',
      principal: LOCAL_PRINCIPAL,
      resolve: () => okResolution(launch),
      prompt: 'hi',
      preflight: () => {
        throw new Error('trust denied')
      },
      reservationId,
      expectedStableInputDigest: 'stable-A'
    })
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect('failure' in result && result.failure.code).toBe('trust_preflight_failed')
    expect(store.pendingForPrincipal(LOCAL_PRINCIPAL)).toBe(0)
  })

  it('executeReserved releases the hold on an in-coordinator fingerprint mismatch', async () => {
    const { boundary, store } = makeBoundary()
    const pinned = digestLaunch('fp-1', 'stable-A')
    const { reservationId } = prepareHold(boundary, pinned)
    // Pre-coordinator resolve matches the pin; the in-coordinator re-resolve keeps
    // the same config digest but a changed fingerprint (a relevant edit committed).
    const resolve = vi
      .fn<() => HostStateResolution>()
      .mockReturnValueOnce(okResolution(pinned))
      .mockReturnValueOnce(okResolution(digestLaunch('fp-9', 'stable-A')))
    const result = await boundary.executeReservedAgentLaunch({
      scope: 'wt-1',
      principal: LOCAL_PRINCIPAL,
      resolve,
      prompt: 'hi',
      reservationId,
      expectedStableInputDigest: 'stable-A'
    })
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect('failure' in result && result.failure.code).toBe('agent_configuration_changed')
    expect(store.pendingForPrincipal(LOCAL_PRINCIPAL)).toBe(0)
    expect(resolve).toHaveBeenCalledTimes(2)
  })
})
