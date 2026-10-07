import { beforeEach, describe, expect, it, vi } from 'vitest'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { OrcaRuntimeWithGetOrchestrationDispatchAuthority } =
  await import('./orca-runtime-get-orchestration-dispatch-authority')
const { OrcaRuntimeWithVerifyOrchestrationCompatibilityCaller } =
  await import('./orca-runtime-verify-orchestration-compatibility-caller')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('./structured-worker-identity')

const SESSION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

const getAuthority =
  OrcaRuntimeWithGetOrchestrationDispatchAuthority.prototype.getOrchestrationDispatchAuthority
// Both borrowed from the real prototype through their public surface: a stubbed copy of the
// method under test would pin nothing.
const verifyCaller =
  OrcaRuntimeWithVerifyOrchestrationCompatibilityCaller.prototype
    .verifyOrchestrationCompatibilityCaller

function registerStructuredWorker(): string {
  hostRef.current = {
    deps: {
      store: {
        getRecord: () => ({
          location: { executionHostId: 'local', wslDistro: null },
          lease: { runtimeKind: 'native', claimStatus: 'live', runtimeFence: 1 }
        })
      }
    }
  }
  const handle = mintStructuredWorkerHandle()
  structuredWorkerIdentities.register({
    handle,
    sessionId: SESSION_ID,
    agent: 'claude',
    paneKey: mintStructuredWorkerPaneKey(SESSION_ID),
    processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
    worktreeId: 'wt_1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
  return handle
}

function runtimeStub(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: 'runtime-1',
    getOrchestrationDbIfAvailable: () => null,
    restoredOrchestrationAuthorityByPtyId: new Map(),
    getOrchestrationDispatchAuthority: (handle: string) =>
      getAuthority.call(runtimeStub(overrides), handle),
    orchestrationCompatibilityHostMatches: () => true,
    attestAgentHookCompatibilityAuthorityFn: undefined,
    // `freeze...` is protected and is reached only on the SUCCESS path, which every test here
    // asserts is never taken. Leaving it off the stub means a regression that does reach it fails
    // loudly instead of quietly returning a frozen authority.
    ...overrides
  }
}

describe('structured worker hook attestation stays closed', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    hostRef.current = null
  })

  it('leaves both the launch token hash and the pty id empty', () => {
    const handle = registerStructuredWorker()
    const authority = getAuthority.call(runtimeStub(), handle)
    expect(authority).not.toBeNull()
    expect(authority!.launchTokenHash).toBeNull()
    // Non-empty would make the restored-authority receipt lookup reachable.
    expect(authority!.ptyId).toBe('')
  })

  it('refuses to attest a structured handle as a compatibility caller', () => {
    const handle = registerStructuredWorker()
    const stub = runtimeStub()
    expect(
      verifyCaller.call(stub, {
        terminalHandle: handle,
        paneKey: structuredWorkerIdentities.get(handle)!.paneKey,
        launchToken: 'anything-the-caller-claims'
      })
    ).toBeNull()
  })

  it('still refuses when a restored receipt exists under an empty pty id', () => {
    const handle = registerStructuredWorker()
    const identity = structuredWorkerIdentities.get(handle)!
    // Fabricate the exact receipt the fallback would accept, keyed by the empty pty id.
    const stub = runtimeStub({
      restoredOrchestrationAuthorityByPtyId: new Map([
        [
          '',
          {
            ptyId: '',
            worktreeId: identity.worktreeId,
            terminalHandle: handle,
            paneKey: identity.paneKey,
            processIncarnation: identity.processIncarnation,
            hostScope: identity.hostScope
          }
        ]
      ]),
      orchestrationCompatibilityHostScopesEqual: () => true,
      attestAgentHookCompatibilityAuthorityFn: undefined
    })
    // Even then, attestation is required and there is no hook to provide it.
    expect(
      verifyCaller.call(stub, {
        terminalHandle: handle,
        paneKey: identity.paneKey,
        launchToken: 'anything-the-caller-claims'
      })
    ).toBeNull()
  })
})
