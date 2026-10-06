import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { TuiAgent } from '../../shared/tui-agent'
import * as ownerModule from '../ipc/pty/pane/agent-session-owners'
import {
  AgentSessionClaimSigner,
  canonicalizeAgentSessionIdentity
} from './agent-session-claim-identity'
import { OrcaRuntimeWithGetWorktreePs } from './orca-runtime-get-worktree-ps'

const installed = vi.hoisted((): { deps: StructuredAgentSessionRuntimeDeps | null } => ({
  deps: null
}))
type OwnerLookup = NonNullable<StructuredAgentSessionRuntimeDeps['findTerminalAgentSessionOwner']>
type OwnerLookupParams = Parameters<OwnerLookup>[0]

vi.mock('./structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: vi.fn(async (deps: StructuredAgentSessionRuntimeDeps) => {
    installed.deps = deps
  })
}))

vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: vi.fn(() => '/tmp/orca-test-profile')
}))

vi.mock('../native-chat/agent-session-wire/structured-agent-session-logger', () => ({
  createStructuredAgentSessionLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn() }))
}))

const WORKSPACE: TerminalWorkspaceLaunchScope = {
  id: 'worktree-1',
  path: '/workspace',
  connectionId: null,
  repo: null,
  folderWorkspace: null
}
const NAMESPACE = {
  machine: 'native:darwin',
  principal: 'uid:501',
  container: 'native',
  providerRoot: 'profile-default'
}

function makeRuntime() {
  type MinimalRuntime = {
    agentSessionClaimSigner: AgentSessionClaimSigner
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<TerminalWorkspaceLaunchScope>
    getAgentSessionExecutionNamespace: (
      workspace: TerminalWorkspaceLaunchScope,
      agent: TuiAgent
    ) => typeof NAMESPACE | null
  }
  const runtime: MinimalRuntime = {
    agentSessionClaimSigner: new AgentSessionClaimSigner('test-domain', Buffer.alloc(32, 7)),
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => WORKSPACE),
    getAgentSessionExecutionNamespace: vi.fn(() => NAMESPACE)
  }
  return runtime
}

function ownerParams(
  provider: 'claude' | 'codex',
  entry: 'adopt' | 'providerHandle'
): OwnerLookupParams {
  const providerHandle: NonNullable<OwnerLookupParams['providerHandle']> =
    provider === 'claude'
      ? { kind: 'claude', sessionId: 'claude-session', leafUuid: null }
      : { kind: 'codex', threadId: 'codex-thread' }
  return {
    envelope: {
      sessionId: 'session-1',
      clientOperationId: '1800000000000-00000000000000000000000000000001',
      expectedRuntimeFence: null,
      payloadFingerprint: 'fingerprint'
    },
    agent: provider,
    provider,
    accountHome: {
      variable: provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      path: '/tmp/agent-home'
    },
    runtimeKind: 'native',
    location: {
      executionHostId: 'local',
      workspaceId: WORKSPACE.id,
      wslDistro: null,
      workspaceKind: 'git-worktree'
    },
    ...(entry === 'adopt' ? { adopt: { providerHandle } } : { providerHandle })
  }
}

function claimFor(
  runtime: ReturnType<typeof makeRuntime>,
  params: OwnerLookupParams,
  worktreeId = WORKSPACE.id
) {
  const handle = params.adopt?.providerHandle ?? params.providerHandle
  if (!handle) {
    throw new Error('owner fixture requires a provider handle')
  }
  const providerSession =
    handle.kind === 'claude'
      ? { key: 'session_id' as const, id: handle.sessionId }
      : { key: 'session_id' as const, id: handle.threadId }
  return runtime.agentSessionClaimSigner.createClaim({
    namespace: NAMESPACE,
    identity: canonicalizeAgentSessionIdentity(params.agent, providerSession),
    canonicalWorktreeId: worktreeId
  })
}

async function captureOwnerLookup() {
  installed.deps = null
  const runtime = makeRuntime()
  await Reflect.apply(
    OrcaRuntimeWithGetWorktreePs.prototype.ensureStructuredAgentSessionHost,
    runtime,
    []
  )
  const lookup = readInstalledDeps()?.findTerminalAgentSessionOwner
  expect(lookup).toEqual(expect.any(Function))
  if (!lookup) {
    throw new Error('production owner lookup was not installed')
  }
  return {
    runtime,
    lookup
  }
}

function readInstalledDeps(): StructuredAgentSessionRuntimeDeps | null {
  return installed.deps
}

describe('production terminal owner lookup binding', () => {
  beforeEach(() => {
    vi.spyOn(ownerModule, 'reconcileAgentSessionOwnerListings').mockResolvedValue()
  })

  afterEach(() => {
    ownerModule.agentSessionOwners.reconcileAuthoritative([], {
      isInAuthoritativeScope: () => true
    })
    vi.restoreAllMocks()
    installed.deps = null
  })

  it.each([
    ['claude', 'adopt'],
    ['claude', 'providerHandle'],
    ['codex', 'adopt'],
    ['codex', 'providerHandle']
  ] as const)(
    'uses the same %s claim for %s and finds a recovered owner',
    async (provider, entry) => {
      const { runtime, lookup } = await captureOwnerLookup()
      const params = ownerParams(provider, entry)
      const claim = claimFor(runtime, params)
      await ownerModule.agentSessionOwners.ensure({
        claim,
        surface: {
          worktreeId: WORKSPACE.id,
          tabId: 'tab-1',
          leafId: 'leaf-1',
          terminalHandle: 'term-1'
        },
        spawn: async ({ generation }) => ({
          ptyId: 'pty-1',
          owner: {
            claim,
            generation,
            phase: 'live' as const,
            ptyId: 'pty-1',
            surface: {
              worktreeId: WORKSPACE.id,
              tabId: 'tab-1',
              leafId: 'leaf-1',
              terminalHandle: 'term-1'
            }
          }
        })
      })

      expect(await lookup(params)).toBe('owned')
    }
  )

  it('returns available when the matching local owner is absent', async () => {
    const { lookup } = await captureOwnerLookup()
    expect(await lookup(ownerParams('codex', 'providerHandle'))).toBe('available')
  })

  it('keeps an owner when the callback resolves another worktree in the same namespace', async () => {
    const { runtime, lookup } = await captureOwnerLookup()
    const params = ownerParams('codex', 'providerHandle')
    const claim = claimFor(runtime, params, WORKSPACE.id)
    await ownerModule.agentSessionOwners.ensure({
      claim,
      surface: {
        worktreeId: WORKSPACE.id,
        tabId: 'tab-1',
        leafId: 'leaf-1',
        terminalHandle: 'term-1'
      },
      spawn: async ({ generation }) => ({
        ptyId: 'pty-1',
        owner: {
          claim,
          generation,
          phase: 'live' as const,
          ptyId: 'pty-1',
          surface: {
            worktreeId: WORKSPACE.id,
            tabId: 'tab-1',
            leafId: 'leaf-1',
            terminalHandle: 'term-1'
          }
        }
      })
    })
    runtime.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
      ...WORKSPACE,
      id: 'worktree-2'
    }))
    params.location.workspaceId = 'worktree-2'

    expect(await lookup(params)).toBe('owned')
  })

  it('keeps a conflicted recovered identity owned across worktrees', async () => {
    const { runtime, lookup } = await captureOwnerLookup()
    const params = ownerParams('codex', 'providerHandle')
    const first = claimFor(runtime, params, 'worktree-1')
    const second = claimFor(runtime, params, 'worktree-2')
    ownerModule.agentSessionOwners.reconcileAuthoritative(
      [
        {
          claim: first,
          generation: 'generation-1',
          phase: 'live',
          ptyId: 'pty-1',
          surface: {
            worktreeId: 'worktree-1',
            tabId: 'tab-1',
            leafId: 'leaf-1',
            terminalHandle: 'term-1'
          }
        },
        {
          claim: second,
          generation: 'generation-2',
          phase: 'live',
          ptyId: 'pty-2',
          surface: {
            worktreeId: 'worktree-2',
            tabId: 'tab-2',
            leafId: 'leaf-2',
            terminalHandle: 'term-2'
          }
        }
      ],
      { isInAuthoritativeScope: () => true }
    )
    runtime.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
      ...WORKSPACE,
      id: 'worktree-2'
    }))
    params.location.workspaceId = 'worktree-2'

    expect(await lookup(params)).toBe('owned')
  })

  it('fails closed when owner listing reconciliation fails', async () => {
    const { lookup } = await captureOwnerLookup()
    const reconciliation = vi.spyOn(ownerModule, 'reconcileAgentSessionOwnerListings')
    reconciliation.mockRejectedValueOnce(new Error('listing unavailable'))
    expect(await lookup(ownerParams('codex', 'providerHandle'))).toBe('unknown')
  })

  it('does not consult the local registry for nonlocal or SSH namespaces', async () => {
    const { runtime, lookup } = await captureOwnerLookup()
    const reconciliation = vi.spyOn(ownerModule, 'reconcileAgentSessionOwnerListings')
    const nonlocal = ownerParams('codex', 'providerHandle')
    nonlocal.location.executionHostId = 'ssh:remote-host'
    expect(await lookup(nonlocal)).toBe('unknown')

    runtime.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
      ...WORKSPACE,
      connectionId: 'ssh-1'
    }))
    runtime.getAgentSessionExecutionNamespace = vi.fn(() => null)
    expect(await lookup(ownerParams('codex', 'providerHandle'))).toBe('unknown')
    expect(reconciliation).not.toHaveBeenCalled()
  })
})
