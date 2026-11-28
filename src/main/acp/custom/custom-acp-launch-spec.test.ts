import { expect, it } from 'vitest'
import { customAcpLaunchSpec } from './custom-acp-launch-spec'
import { createAcpStructuredLaunchResolver } from '../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { agentSessionRecordFixture } from '../../native-chat/testing/agent-session-record-test-fixture'
import type { CustomAcpAgent } from '../../../shared/agent-launch/custom-acp/custom-acp-agent'

const agent = (args: string[], value: string): CustomAcpAgent => ({
  id: 'custom-acp-abc123',
  name: 'Mine',
  command: '/opt/mine/bin/mine',
  args,
  env: { MINE_PROFILE: value }
})

// Saving settings changes the registry's spec in place; `edit` is that save.
function launcher(midLaunch?: () => void) {
  const spec = customAcpLaunchSpec(agent(['acp', 'one'], 'one'))
  const record = agentSessionRecordFixture({
    sessionId: 'session-1',
    provider: spec.agent,
    accountHome: { variable: 'ORCA_CUSTOM_ACP_HOME', path: '/home/me' }
  })
  const launch = createAcpStructuredLaunchResolver(spec, {
    store: { getRecord: () => record, pinLaunchDirectory: async () => record },
    savedSession: { hasProviderTurn: async () => false },
    resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
    // Runs after the launch read its environment and before it reads its arguments.
    resolveCommand: () => {
      midLaunch?.()
      return '/opt/mine/bin/mine'
    }
  })
  const identity = {
    sessionId: record.sessionId,
    workspaceId: record.location.workspaceId,
    hostId: 'local',
    agent: spec.agent,
    providerHandle: null
  }
  return {
    edit: () => Object.assign(spec, customAcpLaunchSpec(agent(['acp', 'two'], 'two'))),
    launch: () => launch({ identity })
  }
}

it('runs the next launch with settings saved after the last one', async () => {
  const { edit, launch } = launcher()
  const first = await launch()
  edit()
  const second = await launch()
  expect(first.args).toEqual(['acp', 'one'])
  expect(first.env.MINE_PROFILE).toBe('one')
  expect(second.args).toEqual(['acp', 'two'])
  expect(second.env.MINE_PROFILE).toBe('two')
})

it('keeps one launch on the settings it started with when they change while it runs', async () => {
  let edit = (): void => {}
  const started = launcher(() => edit())
  edit = () => {
    edit = () => {}
    started.edit()
  }
  const launched = await started.launch()
  expect(launched.args).toEqual(['acp', 'one'])
  expect(launched.env.MINE_PROFILE).toBe('one')
  // The save still reaches the next launch.
  const next = await started.launch()
  expect(next.args).toEqual(['acp', 'two'])
})
