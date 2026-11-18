import { expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { createClaudeStructuredLaunchResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'

it('omits raw effort from SDK options while inheriting unrelated Arguments on restart', async () => {
  const record = {
    ...agentSessionRecordFixture(),
    providerHandleChain: [],
    omitEffort: true as const,
    options: { model: 'opus', fastMode: 'true' }
  }
  let args = ['--effort', 'high', '--add-dir', '/tmp/a"b']
  const resolve = createClaudeStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveLaunchArgs: () => args,
    resolveCommand: () => ({ command: '/usr/local/bin/claude', prefixArgs: [] }),
    resolveInheritedEnv: async () => ({ PATH: '/usr/bin' }),
    resolveAuthPolicy: () => ({ account: 'system' }),
    resolveWorkspacePath: async () => '/folder',
    hasTranscript: async () => false
  })
  const identity = {
    sessionId: record.sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'claude' as const,
    providerHandle: null
  }
  const first = await resolve({ identity })
  expect(first.options.additionalDirectories).toEqual(['/tmp/a"b'])
  expect(first.options.extraArgs).toEqual({ 'replay-user-messages': null })
  expect(first.options.effort).toBeUndefined()
  args = ['--effort=low', '--add-dir', "/tmp/don't panic"]
  const restarted = await resolve({ identity })
  expect(restarted.options.additionalDirectories).toEqual(["/tmp/don't panic"])
  expect(restarted.options.extraArgs).toEqual({ 'replay-user-messages': null })
  expect(restarted.options.effort).toBeUndefined()
})
