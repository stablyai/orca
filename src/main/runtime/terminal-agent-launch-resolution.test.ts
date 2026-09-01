// The terminal-create host-launch resolver: it drives the shared boundary from a
// terminal workspace descriptor, marks trust through the boundary preflight,
// injects detection, and maps the admitted plan to terminal option fields — never
// argv/env/snapshot beyond the resolved plan.
import { describe, expect, it, vi } from 'vitest'
import {
  resolveTerminalAgentLaunch,
  type TerminalAgentLaunchDeps
} from './terminal-agent-launch-resolution'
import { AgentSessionRecordStore } from '../agent-launch/agent-session-record-store'
import { AgentLaunchBoundary } from '../agent-launch/agent-launch-boundary'
import {
  AgentLaunchAdmissionStore,
  LaunchAdmissionCoordinator
} from '../agent-launch/agent-launch-admission-store'
import type { AgentLaunchHostDescriptor } from '../agent-launch/agent-launch-host-state'
import type { GlobalSettings, TuiAgent } from '../../shared/types'
import type {
  ResolveAgentLaunchRequest,
  ResolvedAgentLaunch,
  AgentLaunchSnapshot
} from '../../shared/agent-launch-host-contract'
import type { ResolveAgentLaunchOutcome } from '../agent-launch/resolve-agent-launch'
import type { AuthenticatedClientKind } from '../agent-launch/agent-launch-boundary'
import { scanForCustomEnvLeak } from '../../shared/custom-env-leak-scan'

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

const DESCRIPTOR: AgentLaunchHostDescriptor = { kind: 'local', platform: 'linux', shell: 'posix' }

function makeDeps(
  resolve: (request: ResolveAgentLaunchRequest) => ResolveAgentLaunchOutcome,
  overrides: Partial<TerminalAgentLaunchDeps> = {}
): TerminalAgentLaunchDeps {
  return {
    boundary: new AgentLaunchBoundary({
      admissionStore: new AgentLaunchAdmissionStore(),
      coordinator: new LaunchAdmissionCoordinator()
    }),
    getSettings: () => ({}) as GlobalSettings,
    getCatalogRevision: () => 4,
    detectStockBaseAgents: vi.fn(async () => ['claude']),
    resolveTargetHomePath: vi.fn(async () => '/home/dev'),
    markWorkspaceTrusted: vi.fn(),
    sessionRecordStore: new AgentSessionRecordStore(),
    resolve: (request) => resolve(request),
    ...overrides
  }
}

function makeArgs(clientKind: AuthenticatedClientKind = undefined) {
  return {
    request: { selection: { kind: 'agent' as const, agent: 'claude' as const }, prompt: 'go' },
    clientKind,
    descriptor: DESCRIPTOR,
    scope: 'wt-1',
    worktreePath: '/repo/wt',
    repoPath: '/repo',
    principal: { kind: 'local' as const }
  }
}

describe('resolveTerminalAgentLaunch', () => {
  it('maps a resolved launch to terminal fields with the settle token + receipt', async () => {
    const resolve = vi.fn(() => ({ ok: true as const, launch: makeLaunch() }))
    const trusted: ResolvedAgentLaunch[] = []
    const detectStockBaseAgents = vi.fn(async () => ['claude'])
    const deps = makeDeps(resolve, {
      detectStockBaseAgents,
      markWorkspaceTrusted: (launch) => {
        trusted.push(launch)
      }
    })
    const result = await resolveTerminalAgentLaunch(deps, makeArgs())

    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') {
      return
    }
    // The command is the host-resolved argv, and launchAgent is the built-in base.
    expect(result.fields.command).toContain('/opt/resolved-claude')
    expect(result.fields.launchAgent).toBe('claude')
    expect(typeof result.fields.launchToken).toBe('string')
    expect(result.admissionToken).toBe(result.fields.launchToken)
    expect(result.receipt.baseAgent).toBe('claude')
    expect(result.receipt.catalogRevision).toBe(4)
    // A stdin-after-start launch threads the prompt as a post-ready followup the
    // host submits on its own spawned terminal (never a client-delivered send).
    expect(result.fields.postReadyPrompt).toEqual({
      expectedProcess: 'claude',
      followupPrompt: 'go'
    })
    // Detection ran against the target descriptor.
    expect(detectStockBaseAgents).toHaveBeenCalledWith(DESCRIPTOR, ['claude'])
    // Trust preflight marked the workspace for the resolved launch before admission.
    expect(trusted).toHaveLength(1)
    expect(trusted[0]!.baseAgent).toBe('claude')
  })

  it.each([
    [undefined, 'desktop'],
    ['runtime', 'paired-web'],
    ['mobile', 'mobile']
  ] as const)('maps clientKind %s to launch intent client %s', async (clientKind, expected) => {
    let captured: ResolveAgentLaunchRequest | null = null
    const resolve = (request: ResolveAgentLaunchRequest): ResolveAgentLaunchOutcome => {
      captured = request
      return { ok: true as const, launch: makeLaunch() }
    }
    const deps = makeDeps(resolve)
    await resolveTerminalAgentLaunch(deps, makeArgs(clientKind))
    expect(captured!.intent).toEqual({ kind: 'interactive', client: expected })
  })

  it('returns a failed outcome (no fields) for a typed resolution failure', async () => {
    const resolve = vi.fn(() => ({
      ok: false as const,
      failure: { code: 'base_agent_disabled' as const, baseAgent: 'claude' as const }
    }))
    const deps = makeDeps(resolve)
    const result = await resolveTerminalAgentLaunch(deps, makeArgs('mobile'))
    expect(result).toEqual({
      kind: 'failed',
      outcome: {
        status: 'failed',
        failure: { code: 'base_agent_disabled', baseAgent: 'claude' }
      }
    })
  })

  it('returns a rejected outcome for a request error', async () => {
    const resolve = vi.fn(() => ({
      ok: false as const,
      requestError: { code: 'untrusted_reference' as const }
    }))
    const deps = makeDeps(resolve)
    const result = await resolveTerminalAgentLaunch(deps, makeArgs())
    expect(result).toEqual({
      kind: 'failed',
      outcome: { status: 'rejected', requestError: { code: 'untrusted_reference' } }
    })
  })

  it('never carries a custom env key/value in the client receipt (G7 oracle-12/13)', async () => {
    const ENV_KEY = 'ZZLEAKKEY_RECEIPT'
    const ENV_VALUE = 'zzleakvalue_receipt_4b8'
    const customId = 'custom-agent:claude:01234567-89ab-4cde-8f01-23456789abcd' as TuiAgent
    const resolve = vi.fn(() => ({
      ok: true as const,
      launch: {
        ...makeLaunch(),
        requestedAgent: customId,
        displayLabel: 'Env Agent',
        // The launch object DOES carry the admitted env; the client-crossing
        // receipt must drop every trace of it.
        agentEnv: { [ENV_KEY]: ENV_VALUE },
        policy: { ...makeLaunch().policy, mode: 'custom' as const, env: 'full' as const },
        notices: [{ code: 'env_withheld' as const, label: 'Env Agent' }],
        telemetry: { agentKind: 'claude-code' as const, usedCustomAgent: true }
      }
    }))
    const deps = makeDeps(resolve)
    const result = await resolveTerminalAgentLaunch(deps, makeArgs('mobile'))
    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') {
      return
    }
    expect(scanForCustomEnvLeak(result.receipt, [ENV_KEY, ENV_VALUE])).toEqual([])
  })

  it('never lets an untrusted client escalate to an unattended intent (GP3)', async () => {
    // Ledger #6 GP3 pin: convert the safe-by-construction inference into an
    // asserted property. A client cannot mint automation/background/orchestration
    // authority on the runtime RPC surface — the host derives the intent from the
    // authenticated clientKind, so a client-declared `unattended` is dropped and
    // its prompt can only ever ride an interactive (bounded-draft) intent. Owner
    // prompt authority is host-constructed and never reachable from a client here.
    let captured: ResolveAgentLaunchRequest | null = null
    const resolve = (request: ResolveAgentLaunchRequest): ResolveAgentLaunchOutcome => {
      captured = request
      return { ok: true as const, launch: makeLaunch() }
    }
    const deps = makeDeps(resolve)
    await resolveTerminalAgentLaunch(deps, {
      ...makeArgs('mobile'),
      request: {
        selection: { kind: 'agent' as const, agent: 'claude' as const },
        prompt: 'client-supplied draft that must never ride owner authority',
        unattended: { kind: 'background' as const }
      }
    })
    expect(captured!.intent).toEqual({ kind: 'interactive', client: 'mobile' })
  })
})

describe('resolveTerminalAgentLaunch target-host planning (U7 oracle-14)', () => {
  const WINDOWS_POWERSHELL: AgentLaunchHostDescriptor = {
    kind: 'local',
    platform: 'win32',
    shell: 'powershell'
  }
  const WINDOWS_CMD: AgentLaunchHostDescriptor = { kind: 'local', platform: 'win32', shell: 'cmd' }
  const WSL_LINUX: AgentLaunchHostDescriptor = { kind: 'local', platform: 'linux', shell: 'posix' }
  const SSH_LINUX: AgentLaunchHostDescriptor = {
    kind: 'ssh',
    connectionId: 'conn-1',
    platform: 'linux',
    shell: 'posix'
  }

  // A paired-web/iOS client only names the identity; the host plans from the
  // TARGET execution host it derives, never the phone/browser OS. The resolver's
  // own assembly suite proves platform/shell → target quoting; this proves those
  // target values (and the detection descriptor) reach the resolver on the
  // untrusted client surface regardless of clientKind.
  it.each([
    ['runtime', WINDOWS_POWERSHELL, 'win32', 'powershell'],
    ['mobile', WINDOWS_POWERSHELL, 'win32', 'powershell'],
    ['runtime', WINDOWS_CMD, 'win32', 'cmd'],
    ['mobile', WSL_LINUX, 'linux', 'posix'],
    ['runtime', SSH_LINUX, 'linux', 'posix']
  ] as const)(
    'plans a %s client launch from the target descriptor (%o → %s/%s), not the client OS',
    async (clientKind, descriptor, platform, shell) => {
      let captured: ResolveAgentLaunchRequest | null = null
      const resolve = (request: ResolveAgentLaunchRequest): ResolveAgentLaunchOutcome => {
        captured = request
        return { ok: true as const, launch: makeLaunch() }
      }
      const detectStockBaseAgents = vi.fn(async () => null)
      const deps = makeDeps(resolve, { detectStockBaseAgents })
      await resolveTerminalAgentLaunch(deps, { ...makeArgs(clientKind), descriptor })
      // The target platform/shell reach the resolver — the mobile/web client OS
      // never participates in quoting.
      expect(captured!.platform).toBe(platform)
      expect(captured!.shell).toBe(shell)
      expect(captured!.isRemote).toBe(descriptor.kind === 'ssh')
      // Stock detection ran against the TARGET descriptor, not a client host.
      expect(detectStockBaseAgents).toHaveBeenCalledWith(descriptor, ['claude'])
    }
  )
})

describe('resolveTerminalAgentLaunch recipe-arg threading (U7)', () => {
  it('threads a source-control recipe override from recipeRepo into perLaunchArgs', async () => {
    let captured: ResolveAgentLaunchRequest | null = null
    const resolve = (request: ResolveAgentLaunchRequest): ResolveAgentLaunchOutcome => {
      captured = request
      return { ok: true as const, launch: makeLaunch() }
    }
    const deps = makeDeps(resolve)
    await resolveTerminalAgentLaunch(deps, {
      ...makeArgs(),
      request: {
        selection: { kind: 'agent' as const, agent: 'claude' as const },
        prompt: 'go',
        sourceRecord: { owner: 'source-control-recipe' as const, id: 'fixChecks' }
      },
      // Host-trusted repo override — the caller derives it from the workspace.
      recipeRepo: {
        sourceControlAi: { actionOverrides: { fixChecks: { agentArgs: '--recipe one' } } }
      }
    })
    expect(captured!.perLaunchArgs).toBe('--recipe one')
  })

  it('rejects an unknown recipe id with untrusted_reference and never resolves', async () => {
    const resolve = vi.fn(() => ({ ok: true as const, launch: makeLaunch() }))
    const deps = makeDeps(resolve)
    const result = await resolveTerminalAgentLaunch(deps, {
      ...makeArgs(),
      request: {
        selection: { kind: 'agent' as const, agent: 'claude' as const },
        prompt: 'go',
        sourceRecord: { owner: 'source-control-recipe' as const, id: 'not-a-real-action' }
      },
      recipeRepo: { sourceControlAi: {} }
    })
    expect(result).toEqual({
      kind: 'failed',
      outcome: { status: 'rejected', requestError: { code: 'untrusted_reference' } }
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('leaves perLaunchArgs unset when recipeRepo is absent and the record is non-recipe', async () => {
    let captured: ResolveAgentLaunchRequest | null = null
    const resolve = (request: ResolveAgentLaunchRequest): ResolveAgentLaunchOutcome => {
      captured = request
      return { ok: true as const, launch: makeLaunch() }
    }
    const deps = makeDeps(resolve)
    await resolveTerminalAgentLaunch(deps, {
      ...makeArgs(),
      request: {
        selection: { kind: 'agent' as const, agent: 'claude' as const },
        prompt: 'go',
        sourceRecord: { owner: 'quick-command' as const, id: 'qc-1' }
      }
    })
    expect('perLaunchArgs' in captured!).toBe(false)
  })
})

describe('resolveTerminalAgentLaunch Source Control AI provider contract (plan §1364)', () => {
  // §1364: the SAME custom-agent launch assertion must hold for GitHub, GitLab, and
  // one non-GitHub/GitLab generic review provider. A provider adapter may supply the
  // review work item's task text/URLs, but none may reinterpret the custom agent id
  // or assemble its command — the id reaches the resolver unchanged and only the host
  // recipe contributes the per-launch argv band.
  const CUSTOM_AGENT = 'custom-agent:codex:sc-ai-review' as const

  it.each([
    ['github', 'Review PR github.com/acme/app/pull/12'],
    ['gitlab', 'Review MR gitlab.com/acme/app/-/merge_requests/34'],
    ['generic', 'Review change bitbucket.org/acme/app/pull-requests/56']
  ] as const)(
    'resolves the same custom-agent recipe launch for a %s review work item',
    async (_provider, providerTaskText) => {
      let captured: ResolveAgentLaunchRequest | null = null
      const resolve = (request: ResolveAgentLaunchRequest): ResolveAgentLaunchOutcome => {
        captured = request
        return { ok: true as const, launch: makeLaunch() }
      }
      const deps = makeDeps(resolve)
      const result = await resolveTerminalAgentLaunch(deps, {
        ...makeArgs(),
        request: {
          selection: { kind: 'agent' as const, agent: CUSTOM_AGENT },
          // The provider-supplied review context is the only provider-varying input.
          prompt: providerTaskText,
          sourceRecord: { owner: 'source-control-recipe' as const, id: 'fixChecks' }
        },
        recipeRepo: {
          sourceControlAi: { actionOverrides: { fixChecks: { agentArgs: '--recipe one' } } }
        }
      })

      expect(result.kind).toBe('resolved')
      if (result.kind !== 'resolved') {
        return
      }
      // (1) the custom agent id reaches the resolver unchanged — never reinterpreted.
      expect(captured!.selection).toEqual({ kind: 'agent', agent: CUSTOM_AGENT })
      // (2) only the host recipe contributes argv; the provider assembles no command.
      expect(captured!.perLaunchArgs).toBe('--recipe one')
      // (3) the provider-supplied task text flows through as the launch prompt.
      expect(result.fields.postReadyPrompt?.followupPrompt).toBe(providerTaskText)
    }
  )
})

describe('resolveTerminalAgentLaunch resume/fork', () => {
  const KEY = { worktreeId: 'wt-1', baseAgent: 'claude' as const, providerSessionId: 'sess-1' }

  function storeWithRecord(): AgentSessionRecordStore {
    const store = new AgentSessionRecordStore()
    store.register({
      paneKey: 'pane-a',
      terminalId: 'term-a',
      worktreeId: 'wt-1',
      requestedAgent: 'claude',
      baseAgent: 'claude',
      launchSnapshot: makeSnapshot(),
      launchToken: 'token-a'
    })
    store.bindProviderSessionByToken('token-a', { key: 'session_id', id: 'sess-1' })
    return store
  }

  it('feeds the loaded record snapshot + session into the resolver as a resume intent', async () => {
    let captured: ResolveAgentLaunchRequest | null = null
    const resolve = (request: ResolveAgentLaunchRequest): ResolveAgentLaunchOutcome => {
      captured = request
      return { ok: true as const, launch: makeLaunch() }
    }
    const deps = makeDeps(resolve, { sessionRecordStore: storeWithRecord() })
    const result = await resolveTerminalAgentLaunch(deps, {
      ...makeArgs('mobile'),
      request: { resume: { operation: 'resume', sessionKey: KEY } }
    })
    expect(result.kind).toBe('resolved')
    expect(captured!.intent).toEqual({ kind: 'resume', operation: 'resume', client: 'mobile' })
    expect(captured!.persistedSnapshot).toEqual(makeSnapshot())
    expect(captured!.resumeProviderSession).toEqual({ key: 'session_id', id: 'sess-1' })
  })

  it('fails invalid_launch_snapshot for an unknown session key without resolving', async () => {
    const resolve = vi.fn(() => ({ ok: true as const, launch: makeLaunch() }))
    const deps = makeDeps(resolve, { sessionRecordStore: new AgentSessionRecordStore() })
    const result = await resolveTerminalAgentLaunch(deps, {
      ...makeArgs('mobile'),
      request: { resume: { operation: 'resume', sessionKey: KEY } }
    })
    expect(result).toEqual({
      kind: 'failed',
      outcome: { status: 'failed', failure: { code: 'invalid_launch_snapshot' } }
    })
    // No record → the resolver was never invoked.
    expect(resolve).not.toHaveBeenCalled()
  })
})
