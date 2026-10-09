import { describe, expect, it } from 'vitest'
import {
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
  structuredAgentRuntimeRegistration,
  type StructuredAgentAccountHomeServices
} from './structured-agent-runtime-registrations'
import { decideAgentLaunchMode } from '../agent-launch/agent-launch-mode'

describe('ACP agents in the runtime registrations', () => {
  it('registers Grok beside Claude and Codex with its declared capabilities', () => {
    expect(
      STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(({ definition }) => definition.agent)
    ).toEqual(['pi', 'codex', 'claude', 'grok', 'opencode', 'omp'])
    expect(structuredAgentRuntimeRegistration('grok')?.definition).toMatchObject({
      handleTransport: 'acp',
      accountHomeVariable: 'GROK_HOME',
      capabilities: {
        rewind: false,
        compact: true,
        threadGoal: false,
        contextUsage: true,
        imagePrompts: false,
        steering: 'queue',
        approvalEnforcement: 'orca'
      }
    })
  })

  it('registers OpenCode on the ACP lane pinning its tagged account, with image prompts', () => {
    const definition = structuredAgentRuntimeRegistration('opencode')?.definition
    expect(definition).toMatchObject({
      agent: 'opencode',
      handleTransport: 'acp',
      accountLocatorKind: 'opencode',
      capabilities: { imagePrompts: true, steering: 'queue', approvalEnforcement: 'orca' }
    })
    expect(definition?.accountHomeVariable).toBeUndefined()
  })

  it('leaves the `opencode2` agent on its terminal-backed chat, and asks `opencode` its version', () => {
    expect(structuredAgentRuntimeRegistration('opencode2')).toBeNull()
    expect(structuredAgentRuntimeRegistration('opencode')?.supportsLaunch).toBeTypeOf('function')
    // Grok runs whatever is installed: its create asks nothing of the binary.
    expect(structuredAgentRuntimeRegistration('grok')?.supportsLaunch).toBeUndefined()
  })

  it('registers OMP on the ACP lane pinning its agent directory, asking its version at create', () => {
    const registration = structuredAgentRuntimeRegistration('omp')
    expect(registration?.definition).toMatchObject({
      agent: 'omp',
      handleTransport: 'acp',
      accountHomeVariable: 'PI_CODING_AGENT_DIR',
      capabilities: { imagePrompts: false, steering: 'queue', approvalEnforcement: 'orca' }
    })
    expect(registration?.supportsLaunch).toBeTypeOf('function')
  })

  it('opens OMP as a structured chat with Chat UI on', () => {
    const settings = {
      experimentalNativeChat: true
    }
    const placement = { agent: 'omp', workspaceKind: 'git-worktree' } as const
    expect(decideAgentLaunchMode({ placement, settings }).mode).toBe('structured')
    // Off: new OMP launches use the terminal.
    expect(
      decideAgentLaunchMode({
        placement,
        settings: { experimentalNativeChat: false }
      })
    ).toMatchObject({ mode: 'terminal', reason: 'user_default' })
  })

  it("finds OMP's agent directory from the launch env, else OMP's default", async () => {
    const { resolveAccountHome } = structuredAgentRuntimeRegistration('omp')!
    const unused = (): never => {
      throw new Error('OMP resolves its account home without the runtime')
    }
    const resolve = async (launchEnv: NodeJS.ProcessEnv) =>
      resolveAccountHome(
        { launchEnv, location: null, purpose: 'read', workspacePath: null },
        {
          getClaudeConfigDirectory: unused,
          prepareCodexLaunchHome: unused,
          readCodexLaunchHome: unused,
          workspaceTrustSettings: unused
        }
      )
    await expect(resolve({ PI_CODING_AGENT_DIR: '/data/omp-agent' })).resolves.toEqual({
      variable: 'PI_CODING_AGENT_DIR',
      path: '/data/omp-agent'
    })
    await expect(resolve({ PI_CODING_AGENT_DIR: '' })).resolves.toMatchObject({
      path: expect.stringMatching(/[\\/]\.omp[\\/]agent$/)
    })
  })

  it('takes model and effort picks at rest, and keeps no model list of its own', () => {
    const resting = structuredAgentRuntimeRegistration('grok')!.definition.restingOptions
    expect(['model', 'effort'].map(resting.acceptsKey)).toEqual([true, true])
    expect(resting.acceptsKey('fastMode')).toBe(false)
    expect(resting.fallbackModels()).toBeNull()
  })

  it('finds the account home on this runtime from the launch env, else the default', async () => {
    const { resolveAccountHome } = structuredAgentRuntimeRegistration('grok')!
    // Grok's resolver asks the runtime for nothing: its home is the launch env's, else the default.
    const unused = (): never => {
      throw new Error('Grok resolves its account home without the runtime')
    }
    const services: StructuredAgentAccountHomeServices = {
      getClaudeConfigDirectory: unused,
      prepareCodexLaunchHome: unused,
      readCodexLaunchHome: unused,
      workspaceTrustSettings: unused
    }
    const resolve = async (launchEnv: NodeJS.ProcessEnv) =>
      resolveAccountHome(
        { launchEnv, location: null, purpose: 'read', workspacePath: null },
        services
      )
    await expect(resolve({ GROK_HOME: '/data/grok' })).resolves.toEqual({
      variable: 'GROK_HOME',
      path: '/data/grok'
    })
    await expect(resolve({ GROK_HOME: 'relative/grok' })).resolves.toMatchObject({
      path: expect.stringMatching(/\.grok$/)
    })
  })

  it('runs Grok only where this runtime supervises the child itself', () => {
    const { supportsLocation } = structuredAgentRuntimeRegistration('grok')!
    const local = {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    } as const
    expect(supportsLocation({ ...local, wslDistro: 'Ubuntu' })).toBe(false)
    expect(supportsLocation({ ...local, executionHostId: 'ssh:box' })).toBe(false)
  })
})
