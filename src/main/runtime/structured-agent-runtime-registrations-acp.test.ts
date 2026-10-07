import { describe, expect, it } from 'vitest'
import {
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
  structuredAgentRuntimeRegistration,
  type StructuredAgentAccountHomeServices
} from './structured-agent-runtime-registrations'

describe('ACP agents in the runtime registrations', () => {
  it('registers Grok beside Claude and Codex with its declared capabilities', () => {
    expect(
      STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(({ definition }) => definition.agent)
    ).toEqual(['codex', 'claude', 'grok'])
    expect(structuredAgentRuntimeRegistration('grok')?.definition).toMatchObject({
      handleTransport: 'acp',
      accountHomeVariable: 'GROK_HOME',
      capabilities: {
        rewind: false,
        compact: false,
        threadGoal: false,
        contextUsage: true,
        imagePrompts: false,
        steering: 'queue',
        approvalEnforcement: 'orca'
      }
    })
  })

  it('takes model and effort picks at rest, and keeps no model list of its own', () => {
    const resting = structuredAgentRuntimeRegistration('grok')!.definition.restingOptions
    expect(['model', 'effort'].map(resting.acceptsKey)).toEqual([true, true])
    expect(resting.acceptsKey('fastMode')).toBe(false)
    expect(resting.fallbackModels()).toBeNull()
  })

  it('finds the account home on this runtime from the launch env, else the default', async () => {
    const { resolveAccountHomePath } = structuredAgentRuntimeRegistration('grok')!
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
    const resolve = (launchEnv: NodeJS.ProcessEnv) =>
      resolveAccountHomePath({ launchEnv, location: null, purpose: 'read' }, services)
    await expect(resolve({ GROK_HOME: '/data/grok' })).resolves.toBe('/data/grok')
    await expect(resolve({ GROK_HOME: 'relative/grok' })).resolves.toMatch(/\.grok$/)
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
