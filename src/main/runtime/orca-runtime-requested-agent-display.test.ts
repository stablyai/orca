/** Custom launch identity for paired-client display. The spawn/behavior side is
 *  keyed on the BUILT-IN base (`pty.launchAgent`); the requested (possibly
 *  custom) identity must survive as a separate display-only field
 *  (`launchRequestedAgent`, published as `requestedAgent` on session tabs) or
 *  web/mobile paired clients show the base harness instead of the custom agent.
 *  Optional per remote-wire-compatibility rule 1: absent means base identity. */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => ({ isDestroyed: () => false })) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const CUSTOM_AGENT_ID = 'custom-agent:codex:01234567-89ab-4cde-8f01-23456789abcd' as const
const WORKTREE_ID = 'repo-1::/tmp/wt-display'
const PTY_ID = `${WORKTREE_ID}@@d15b1a4e`

type RuntimeInternals = {
  resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  resolveAgentTerminalCreateOptions: ReturnType<typeof vi.fn>
  ptysById: Map<string, { launchAgent: string | null; launchRequestedAgent: string | null }>
  mobileSessionTabsByWorktree: Map<
    string,
    { tabs: { requestedAgent?: string; launchAgent?: string }[] }
  >
  registerPty: (
    ptyId: string,
    worktreeId: string,
    connectionId: string | null,
    binding?: {
      tabId: string
      leafId: string
      incarnationId?: string
      agentLaunchAuthority?: { launchToken: string; launchAgent: string; requestedAgent?: string }
    }
  ) => void
}

function launchedResolution(requestedAgent: string) {
  return {
    kind: 'launched',
    admissionToken: 'tok-display',
    receipt: {
      requestedAgent,
      baseAgent: 'codex',
      notices: [],
      launchToken: 'tok-display',
      catalogRevision: 1,
      telemetry: { agentKind: 'codex', usedCustomAgent: requestedAgent !== 'codex' }
    },
    options: {
      command: 'codex --profile custom',
      launchConfig: { agentArgs: '', agentEnv: {} },
      launchAgent: 'codex',
      launchToken: 'tok-display'
    }
  }
}

function createRuntime(): { runtime: OrcaRuntimeService; internal: RuntimeInternals } {
  const runtime = new OrcaRuntimeService()
  const internal = runtime as unknown as RuntimeInternals
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: WORKTREE_ID,
    path: '/tmp/wt-display',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  }))
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  } as never)
  runtime.attachWindow(1)
  return { runtime, internal }
}

describe('requested-agent display identity on host-resolved launches', () => {
  it('stamps the custom requested identity beside the built-in base and publishes it', async () => {
    const { runtime, internal } = createRuntime()
    internal.resolveAgentTerminalCreateOptions = vi.fn(async () =>
      launchedResolution(CUSTOM_AGENT_ID)
    )

    await runtime.createTerminal(`id:${WORKTREE_ID}`, {})

    const pty = internal.ptysById.get(PTY_ID)
    expect(pty?.launchAgent).toBe('codex')
    expect(pty?.launchRequestedAgent).toBe(CUSTOM_AGENT_ID)
    const tabs = internal.mobileSessionTabsByWorktree.get(WORKTREE_ID)?.tabs ?? []
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ launchAgent: 'codex', requestedAgent: CUSTOM_AGENT_ID })
  })

  it('omits requestedAgent when the launch is the base agent itself', async () => {
    const { runtime, internal } = createRuntime()
    internal.resolveAgentTerminalCreateOptions = vi.fn(async () => launchedResolution('codex'))

    await runtime.createTerminal(`id:${WORKTREE_ID}`, {})

    const pty = internal.ptysById.get(PTY_ID)
    expect(pty?.launchAgent).toBe('codex')
    expect(pty?.launchRequestedAgent).toBeNull()
    const tabs = internal.mobileSessionTabsByWorktree.get(WORKTREE_ID)?.tabs ?? []
    expect('requestedAgent' in (tabs[0] ?? {})).toBe(false)
  })
})

describe('requested-agent on renderer launch-authority admission', () => {
  const BINDING = {
    tabId: '11111111-1111-4111-8111-111111111111',
    leafId: '22222222-2222-4222-8222-222222222222',
    incarnationId: 'inc-1'
  }

  it('admits a custom requestedAgent alongside the base launchAgent', () => {
    const { internal } = createRuntime()
    internal.registerPty(PTY_ID, WORKTREE_ID, null, {
      ...BINDING,
      agentLaunchAuthority: {
        launchToken: 'tok-authority',
        launchAgent: 'codex',
        requestedAgent: CUSTOM_AGENT_ID
      }
    })

    const pty = internal.ptysById.get(PTY_ID)
    expect(pty?.launchAgent).toBe('codex')
    expect(pty?.launchRequestedAgent).toBe(CUSTOM_AGENT_ID)
  })

  it('stores no requested identity when it matches the base', () => {
    const { internal } = createRuntime()
    internal.registerPty(PTY_ID, WORKTREE_ID, null, {
      ...BINDING,
      agentLaunchAuthority: {
        launchToken: 'tok-authority',
        launchAgent: 'codex',
        requestedAgent: 'codex'
      }
    })

    expect(internal.ptysById.get(PTY_ID)?.launchRequestedAgent).toBeNull()
  })
})
