import { assertTerminalProfilesStayLocal } from '../../shared/terminal-profile-routing'
import { describe, expect, it } from 'vitest'
import { sleepingAgentLaunchConfigSchema } from '../../shared/workspace-session-sleeping-agents'
import { buildSleepingAgentLaunchConfig } from '../../shared/sleeping-agent-launch-config'
import { copySleepingAgentLaunchConfig } from './runtime-agent-launch-resolution'
import type { AgentProfileSnapshot } from '../../shared/agent-launch-profile'

const snapshot: AgentProfileSnapshot = {
  id: 'work',
  name: 'Work',
  agent: 'codex',
  hostId: 'local',
  executable: '/bin/codex',
  binding: { kind: 'managed', accountId: 'a' },
  resolvedHome: '/accounts/a',
  identity: { kind: 'verified', subject: 'a', displayName: 'A' }
}
describe('durable terminal profile bindings', () => {
  it('rejects a damaged explicit snapshot instead of dropping the launch config', () => {
    expect(
      sleepingAgentLaunchConfigSchema.safeParse({
        agentArgs: '',
        agentEnv: {},
        agentProfile: { id: 'broken' }
      }).success
    ).toBe(false)
  })
  it('retains and deep copies the immutable snapshot through builders and runtime copies', () => {
    const config = buildSleepingAgentLaunchConfig({ agentProfile: snapshot })
    const copy = copySleepingAgentLaunchConfig(config)
    expect(copy.agentProfile).toEqual(snapshot)
    expect(copy.agentProfile?.binding).not.toBe(snapshot.binding)
    expect(copy.agentProfile?.identity).not.toBe(snapshot.identity)
    expect(sleepingAgentLaunchConfigSchema.parse(copy)?.agentProfile).toEqual(snapshot)
  })
  it('retains the captured system-auth null separately from absent account evidence', () => {
    expect(
      copySleepingAgentLaunchConfig({ agentArgs: '', agentEnv: {}, claudeAccountId: null })
    ).toHaveProperty('claudeAccountId', null)
  })
})

it('refuses profile transport to paired hosts before older decoders can drop it', () => {
  expect(() => assertTerminalProfilesStayLocal({ agentProfileId: 'a' })).toThrow(/local terminals/)
  expect(() => assertTerminalProfilesStayLocal({ launchConfig: { agentProfile: {} } })).toThrow(
    /local terminals/
  )
  expect(() => assertTerminalProfilesStayLocal({ command: 'codex' })).not.toThrow()
})
