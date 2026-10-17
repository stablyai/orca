import { prepareAdoptedTranscript } from '../native-chat/agent-session-wire/structured-agent-session-adopted-import'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const applyAgentWorkspaceTrust = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('../agent-workspace-trust', () => ({ applyAgentWorkspaceTrust }))

import { OrcaRuntimeService } from './orca-runtime'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { attachFingerprintFields } from '../native-chat/agent-session-wire/structured-agent-session-attach'

beforeEach(() => {
  applyAgentWorkspaceTrust.mockClear()
})

afterEach(() => {
  setStructuredAgentSessionHost(null)
  vi.unstubAllEnvs()
})

function createCodexIntentRuntime(
  settings: Record<string, unknown>,
  workspaceId = 'workspace-1',
  workspacePath = '/repos/workspace-1'
) {
  const prepareCodexStructuredLaunch = vi.fn(() => '/accounts/selected/home')
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create intent only reads getSettings from the store.
    { getSettings: () => ({ agentDefaultEnv: { codex: {} }, ...settings }) } as never,
    undefined,
    { prepareCodexStructuredLaunch }
  )
  vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
    supported: true
  })
  Object.assign(runtime, {
    resolveStructuredAgentSessionLocation: vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId,
      workspaceKind: 'git-worktree' as const
    })),
    resolveRuntimeFileTarget: vi.fn(async () => ({ worktree: { path: workspacePath } }))
  })
  const createIntent = () =>
    runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: `id:${workspaceId}`,
      agent: 'codex'
    })
  return { prepareCodexStructuredLaunch, createIntent }
}

describe('structured Codex folder trust', () => {
  it('takes a floating chat directory from the host-resolved workspace', async () => {
    const { createIntent } = createCodexIntentRuntime(
      {},
      FLOATING_TERMINAL_WORKTREE_ID,
      '/host/floating-folder'
    )

    const intent = await createIntent()

    expect(intent.hostLaunchDirectory).toBe('/host/floating-folder')
    expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith(
      'codex',
      '/host/floating-folder',
      expect.any(Object)
    )
    expect(attachFingerprintFields(intent)).not.toHaveProperty('hostLaunchDirectory')
  })

  it('pre-trusts the chat folder before launch preparation, as a Codex terminal launch does', async () => {
    const { prepareCodexStructuredLaunch, createIntent } = createCodexIntentRuntime({})

    await createIntent()

    expect(applyAgentWorkspaceTrust).toHaveBeenCalledWith('codex', '/repos/workspace-1', {
      env: expect.any(Object),
      claudeAuth: null,
      wslDistro: null,
      connectionId: null
    })
    expect(applyAgentWorkspaceTrust.mock.invocationCallOrder[0]).toBeLessThan(
      prepareCodexStructuredLaunch.mock.invocationCallOrder[0]
    )
  })

  it('writes nothing with the setting off, and still prepares the launch', async () => {
    const { prepareCodexStructuredLaunch, createIntent } = createCodexIntentRuntime({
      agentWorkspaceTrustEnabled: false
    })

    await createIntent()

    expect(applyAgentWorkspaceTrust).not.toHaveBeenCalled()
    expect(prepareCodexStructuredLaunch).toHaveBeenCalledTimes(1)
  })
})

describe('structured agent-session create intent', () => {
  it('returns the recorded owner before CLI source lookup, new-launch support or account preparation', async () => {
    const record = agentSessionRecordFixture()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: early ownership admission only reads the host's record list.
    setStructuredAgentSessionHost({
      deps: { store: { listRecords: () => [record] } }
    } as unknown as StructuredAgentSessionHost)
    const runtime = new OrcaRuntimeService()
    const support = vi
      .spyOn(runtime, 'getStructuredAgentSessionCreateSupport')
      .mockRejectedValue(new Error('fresh launch is unavailable'))
    const sourceRows = vi.spyOn(runtime, 'getAgentProviderSessionRows').mockImplementation(() => {
      throw new Error('source is unavailable')
    })
    await expect(
      runtime.resolveStructuredAgentSessionCreateIntent({
        envelope: { sessionId: 'new-chat', clientOperationId: 'operation-1' },
        worktree: 'id:another-workspace',
        agent: 'claude',
        resumeFrom: {
          providerSessionId: 'provider-session-alpha-1',
          cliSource: { workspaceId: 'another-workspace', paneKey: 'missing-pane' }
        }
      })
    ).rejects.toMatchObject({
      refusal: {
        code: 'agent_session_conflict',
        details: {
          reason: 'conversationHeldElsewhere',
          owner: { sessionId: record.sessionId, workspaceId: record.location.workspaceId }
        }
      }
    })
    expect(support).not.toHaveBeenCalled()
    expect(sourceRows).not.toHaveBeenCalled()
  })

  it('pins the selected Codex launch home after normal launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn(() => '/accounts/selected/home')
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: { codex: { CODEX_HOME: '/configured/home' } },
          nativeChatSessionOptions: {
            codex: {
              model: 'gpt-5.6-sol',
              valuesByModel: {
                'gpt-5.6-sol': { effort: 'medium', fastMode: true, personality: 'concise' }
              }
            }
          }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
        executionHostId: string
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { path: string }
      }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'codex'
    })

    expect(prepareCodexStructuredLaunch).toHaveBeenCalledWith({
      launchEnv: expect.objectContaining({ CODEX_HOME: '/configured/home' })
    })
    expect(intent.accountHome).toEqual({
      variable: 'CODEX_HOME',
      path: '/accounts/selected/home'
    })
    expect(intent.options).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'medium',
      fastMode: 'true',
      permissionMode: 'ask'
    })
  })

  it('resolves the record-less catalog account home read-only, never through launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn(() => '/accounts/selected/home')
    const resolveCodexStructuredLaunchHome = vi.fn(() => '/accounts/selected/home')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the account-home read only consumes getSettings from the store.
    const store = {
      getSettings: () => ({
        agentDefaultEnv: { codex: { CODEX_HOME: '/configured/home' } }
      })
    } as never
    const runtime = new OrcaRuntimeService(store, undefined, {
      prepareCodexStructuredLaunch,
      resolveCodexStructuredLaunchHome
    })

    const accountHome = await runtime.resolveStructuredAgentAccountHome('codex')

    // A read must not run launch preparation: no home sync, no session bridge,
    // no cleared account selection — the read-only sibling answers instead.
    expect(prepareCodexStructuredLaunch).not.toHaveBeenCalled()
    expect(resolveCodexStructuredLaunchHome).toHaveBeenCalledWith({
      launchEnv: expect.objectContaining({ CODEX_HOME: '/configured/home' })
    })
    expect(accountHome).toEqual({ variable: 'CODEX_HOME', path: '/accounts/selected/home' })
  })

  it('pins the configured Claude launch home without Codex launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn()
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: {
            claude: { CLAUDE_CONFIG_DIR: '/configured/claude-home' }
          },
          nativeChatSessionOptions: {
            claude: {
              model: 'opus',
              valuesByModel: { opus: { effort: 'high', fastMode: true } }
            }
          }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
        executionHostId: string
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { path: string }
      }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'claude'
    })

    expect(prepareCodexStructuredLaunch).not.toHaveBeenCalled()
    // Claude was never pre-trusted for a structured chat.
    expect(applyAgentWorkspaceTrust).not.toHaveBeenCalled()
    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/configured/claude-home'
    })
    expect(intent.options).toEqual({
      model: 'opus',
      effort: 'high',
      fastMode: 'true',
      permissionMode: 'ask'
    })
    // createSupport reports this same seed, so a paired client's picker shows what create runs.
    expect(runtime.structuredAgentSessionLaunchSeedOptions('claude')).toEqual(intent.options)
  })

  it('uses the managed Claude launch home before falling back to ~/.claude', async () => {
    const prepareCodexStructuredLaunch = vi.fn()
    const getRuntimeConfigDir = vi.fn(() => '/accounts/managed/claude-home')
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: { claude: {} }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    runtime.setAccountServices({
      claudeAccounts: { getRuntimeConfigDir } as never,
      codexAccounts: {} as never,
      rateLimits: {} as never
    })
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
        executionHostId: string
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { path: string }
      }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'claude'
    })

    expect(getRuntimeConfigDir).toHaveBeenCalledTimes(1)
    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/accounts/managed/claude-home'
    })
  })
})

describe('adopting a conversation recorded outside Orca', () => {
  it('resolves OMP history with the configured launch environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-omp-create-intent-'))
    try {
      const accountHome = join(root, 'account', 'agent')
      const ambientData = join(root, 'ambient-data')
      const launchData = join(root, 'launch-data')
      const workspaceCwd = join(root, 'workspace')
      const sessionId = '0198c2a4-7d1e-7c3a-9a4b-1f2e3d4c5b6a'
      const sessionFile = join(
        launchData,
        'omp',
        'profiles',
        'configured',
        'sessions',
        '-workspace',
        `2026-10-12T00-00-00-000Z_${sessionId}.jsonl`
      )
      await mkdir(join(ambientData, 'omp', 'profiles', 'ambient'), { recursive: true })
      await mkdir(join(launchData, 'omp', 'profiles', 'configured'), { recursive: true })
      await mkdir(join(root, 'account'), { recursive: true })
      await mkdir(workspaceCwd, { recursive: true })
      await mkdir(dirname(sessionFile), { recursive: true })
      await writeFile(
        sessionFile,
        `${JSON.stringify({ type: 'session', id: sessionId, cwd: workspaceCwd })}\n`
      )
      vi.stubEnv('XDG_DATA_HOME', ambientData)
      vi.stubEnv('OMP_PROFILE', 'ambient')
      const runtime = new OrcaRuntimeService(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create intent only reads getSettings from the store.
        {
          getSettings: () => ({
            agentDefaultEnv: {
              omp: {
                PI_CODING_AGENT_DIR: accountHome,
                OMP_CODING_AGENT_DIR: '',
                HOME: root,
                XDG_DATA_HOME: launchData,
                OMP_PROFILE: 'configured'
              }
            }
          })
        } as never
      )
      vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
        supported: true
      })
      Object.assign(runtime, {
        resolveStructuredAgentSessionLocation: vi.fn(async () => ({
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'workspace-1',
          workspaceKind: 'git-worktree' as const
        })),
        resolveRuntimeFileTarget: vi.fn(async () => ({
          worktree: { path: workspaceCwd }
        }))
      })

      const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
        envelope: { sessionId: 'chat-1', clientOperationId: 'operation-1' },
        worktree: 'id:workspace-1',
        agent: 'omp',
        resumeFrom: { providerSessionId: sessionId }
      })

      expect(intent.adopt?.transcriptPath).toBe(sessionFile)
      expect(intent.accountHome).toEqual({ variable: 'PI_CODING_AGENT_DIR', path: accountHome })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses an agent registered with no transcript importer before any adoption work', async () => {
    const runtime = new OrcaRuntimeService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create intent only reads getSettings from the store.
      { getSettings: () => ({ agentDefaultEnv: {} }) } as never
    )
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const resolveStructuredAgentSessionLocation = vi.fn()
    Object.assign(runtime, { resolveStructuredAgentSessionLocation })

    await expect(
      runtime.resolveStructuredAgentSessionCreateIntent({
        envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
        worktree: 'id:workspace-1',
        // Every registered agent adopts; an unregistered one has no importer.
        agent: 'hermes',
        resumeFrom: { providerSessionId: 'provider-1' }
      })
    ).rejects.toMatchObject({
      refusal: {
        code: 'structured_agent_session_unsupported',
        details: { reason: 'hostUnsupported' }
      }
    })
    expect(resolveStructuredAgentSessionLocation).not.toHaveBeenCalled()
  })

  it('adopts the original Pi file into a folder workspace and refuses another folder', async () => {
    const accountHome = await mkdtemp(join(tmpdir(), 'orca-pi-adopt-intent-'))
    vi.stubEnv('PI_CODING_AGENT_DIR', accountHome)
    try {
      const file = join(
        accountHome,
        'sessions',
        '--repos-workspace-1--',
        '2026-10-12T00-00-00-000Z_0198c2a4-7d1e-7c3a-9a4b-1f2e3d4c5b6a.jsonl'
      )
      await mkdir(dirname(file), { recursive: true })
      await writeFile(
        file,
        `${JSON.stringify({ type: 'session', id: '0198c2a4-7d1e-7c3a-9a4b-1f2e3d4c5b6a', cwd: '/repos/workspace-1' })}\n`
      )
      const runtime = new OrcaRuntimeService(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create intent only reads getSettings from the store.
        {
          getSettings: () => ({ agentDefaultEnv: { pi: { PI_CODING_AGENT_DIR: accountHome } } })
        } as never
      )
      vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
        supported: true
      })
      let workspaceDirectory = '/repos/workspace-1'
      Object.assign(runtime, {
        resolveStructuredAgentSessionLocation: vi.fn(async () => ({
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'workspace-1',
          workspaceKind: 'folder' as const
        })),
        resolveRuntimeFileTarget: vi.fn(async () => ({ worktree: { path: workspaceDirectory } }))
      })

      const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
        envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
        worktree: 'id:workspace-1',
        agent: 'pi',
        resumeFrom: { providerSessionId: '0198c2a4-7d1e-7c3a-9a4b-1f2e3d4c5b6a' }
      })

      expect(intent.accountHome).toEqual({ variable: 'PI_CODING_AGENT_DIR', path: accountHome })
      expect(intent.adopt).toEqual({
        providerHandle: { transport: 'jsonl-rpc', agent: 'pi', nativeId: file },
        transcriptPath: file,
        source: {
          providerSessionId: '0198c2a4-7d1e-7c3a-9a4b-1f2e3d4c5b6a',
          workspaceCwd: '/repos/workspace-1'
        }
      })

      workspaceDirectory = '/different-folder'
      const refused = await runtime.resolveStructuredAgentSessionCreateIntent({
        envelope: { sessionId: 'session-2', clientOperationId: 'operation-2' },
        worktree: 'id:workspace-1',
        agent: 'pi',
        resumeFrom: { providerSessionId: '0198c2a4-7d1e-7c3a-9a4b-1f2e3d4c5b6a' }
      })
      expect(await prepareAdoptedTranscript(refused)).toMatchObject({
        ok: false,
        refusal: { code: 'agent_session_identity_required' }
      })
    } finally {
      vi.unstubAllEnvs()
      await rm(accountHome, { recursive: true, force: true })
    }
  })
})
