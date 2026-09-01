// createTerminal's host-resolved agentLaunch wiring: the resolved plan (never the
// client command) spawns exactly one PTY; a pre-spawn typed failure creates none
// and returns the failure arm. Resolution itself is unit-tested separately; here
// it is mocked so the test exercises only createTerminal's spawn/settle wiring.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { resolveTerminalAgentLaunch } from './terminal-agent-launch-resolution'
import { buildClaudeAgentTeamsLaunchPlan } from './claude-agent-teams-shim-env'
import { getHostAgentLaunchBoundary } from '../agent-launch/agent-launch-boundary-host'
import {
  executionHostIdForDescriptor,
  platformForDescriptor,
  type AgentLaunchHostDescriptor
} from '../agent-launch/agent-launch-host-state'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./terminal-agent-launch-resolution', () => ({
  resolveTerminalAgentLaunch: vi.fn()
}))

// Partial mock: default passthrough so the launch tests keep real plan
// building; the pre-registration-throw test overrides it per call.
vi.mock('./claude-agent-teams-shim-env', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    buildClaudeAgentTeamsLaunchPlan: vi.fn(
      actual.buildClaudeAgentTeamsLaunchPlan as typeof buildClaudeAgentTeamsLaunchPlan
    )
  }
})

const resolveMock = vi.mocked(resolveTerminalAgentLaunch)

function stubLaunchScope(runtime: OrcaRuntimeService, path = '/repo/app'): void {
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: 'wt-1',
    path,
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
}

const RECEIPT = {
  requestedAgent: 'claude' as const,
  baseAgent: 'claude' as const,
  notices: [],
  launchToken: 'tok-1',
  catalogRevision: 1,
  telemetry: { agentKind: 'claude-code' as const, usedCustomAgent: false }
}

describe('createTerminal host-resolved agentLaunch', () => {
  it('spawns exactly one PTY from the resolved plan, ignoring the client command', async () => {
    resolveMock.mockResolvedValue({
      kind: 'resolved',
      admissionToken: 'tok-1',
      receipt: RECEIPT,
      fields: {
        command: 'claude --tui',
        launchConfig: { agentArgs: '', agentEnv: {} },
        launchAgent: 'claude',
        launchToken: 'tok-1'
      }
    })
    const runtime = new OrcaRuntimeService()
    stubLaunchScope(runtime)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-1' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const result = await runtime.createTerminal('id:wt-1', {
      command: 'evil --client-controlled',
      agentLaunch: { selection: { kind: 'agent', agent: 'claude' }, prompt: 'hi' }
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ command: 'claude --tui' }))
    expect('handle' in result).toBe(true)
    if (!('handle' in result)) {
      return
    }
    expect(result.ptyId).toBe('pty-1')
    expect(result.agentLaunch).toEqual({ status: 'launched', receipt: RECEIPT })
  })

  it('settles the admitted token failed when plan assembly throws BEFORE spawn (L4-m6)', async () => {
    resolveMock.mockResolvedValue({
      kind: 'resolved',
      admissionToken: 'tok-strand',
      receipt: { ...RECEIPT, launchToken: 'tok-strand' },
      fields: {
        command: 'claude --tui',
        launchConfig: { agentArgs: '', agentEnv: {} },
        launchAgent: 'claude',
        launchToken: 'tok-strand'
      }
    })
    // A throw in the agent-teams plan build (between admission and spawn) used
    // to strand the admitted token; only the spawn promise had a settle catch.
    vi.mocked(buildClaudeAgentTeamsLaunchPlan).mockRejectedValueOnce(new Error('shim dir boom'))
    const settle = vi.spyOn(getHostAgentLaunchBoundary(), 'settleAgentLaunch')
    const runtime = new OrcaRuntimeService()
    stubLaunchScope(runtime)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-1' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal('id:wt-1', {
        agentLaunch: { selection: { kind: 'agent', agent: 'claude' }, prompt: 'hi' }
      })
    ).rejects.toThrow('shim dir boom')

    expect(spawn).not.toHaveBeenCalled()
    expect(settle).toHaveBeenCalledWith('tok-strand', 'failed')
    settle.mockRestore()
  })

  it('creates no PTY and returns the failure arm for a pre-spawn typed failure', async () => {
    resolveMock.mockResolvedValue({
      kind: 'failed',
      outcome: { status: 'failed', failure: { code: 'base_agent_disabled', baseAgent: 'claude' } }
    })
    const runtime = new OrcaRuntimeService()
    stubLaunchScope(runtime)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-1' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const result = await runtime.createTerminal('id:wt-1', {
      agentLaunch: { selection: { kind: 'agent', agent: 'claude' }, prompt: 'hi' }
    })

    expect(spawn).not.toHaveBeenCalled()
    expect(result).toEqual({
      agentLaunch: {
        status: 'failed',
        failure: { code: 'base_agent_disabled', baseAgent: 'claude' }
      }
    })
  })
})

// A WSL surface classified native/local host-ids as `local`, which resolves
// execution 'native' and leaves Windows/UNC {repoPath} values in the Linux argv.
describe('WSL execution-host classification', () => {
  type DescriptorInternals = {
    buildTerminalAgentLaunchDescriptor: (
      workspace: Record<string, unknown>
    ) => AgentLaunchHostDescriptor
    buildRepoAgentLaunchDescriptor: (repo: Record<string, unknown>) => AgentLaunchHostDescriptor
  }

  function makeDescriptorRuntime(): DescriptorInternals {
    const runtime = new OrcaRuntimeService({
      getSettings: () => ({}),
      getProjects: () => []
    } as never)
    return runtime as unknown as DescriptorInternals
  }

  function workspace(path: string): Record<string, unknown> {
    return { id: 'wt-1', path, connectionId: null, repo: null, folderWorkspace: null }
  }

  it('describes a WSL UNC workspace as its own wsl host, never local', () => {
    const descriptor = makeDescriptorRuntime().buildTerminalAgentLaunchDescriptor(
      workspace('\\\\wsl.localhost\\Ubuntu\\home\\me\\app')
    )

    expect(descriptor).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    expect(executionHostIdForDescriptor(descriptor)).toBe('wsl:Ubuntu')
    expect(platformForDescriptor(descriptor)).toBe('linux')
  })

  it('describes a WSL UNC repo as a wsl host at worktree-create time', () => {
    const descriptor = makeDescriptorRuntime().buildRepoAgentLaunchDescriptor({
      id: 'r1',
      path: '\\\\wsl$\\Debian\\srv\\app',
      connectionId: null
    })

    expect(descriptor).toEqual({ kind: 'wsl', distro: 'Debian' })
    expect(executionHostIdForDescriptor(descriptor)).toBe('wsl:Debian')
  })

  it('keeps an ordinary local workspace on the local host', () => {
    expect(
      makeDescriptorRuntime().buildTerminalAgentLaunchDescriptor(workspace('/repo/app'))
    ).toMatchObject({ kind: 'local' })
  })
})
