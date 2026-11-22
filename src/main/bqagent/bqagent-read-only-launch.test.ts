import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../native-chat/testing/agent-session-record-test-fixture'
import { createAcpStructuredLaunchResolver } from '../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { BQAGENT_LAUNCH_SPEC } from './bqagent-acp-launch-spec'

it('refuses a read-only launch when bqagent can execute tools without approval', async () => {
  const record = agentSessionRecordFixture({
    sessionId: 'bq-read-only',
    provider: 'bqagent',
    accountHome: await BQAGENT_LAUNCH_SPEC.account.resolve({
      launchEnv: {},
      stateDirectory: tmpdir()
    })
  })
  const resolve = createAcpStructuredLaunchResolver(BQAGENT_LAUNCH_SPEC, {
    store: { getRecord: () => record, pinLaunchDirectory: async () => record },
    resolveWorkspacePath: async () => tmpdir(),
    readOnlySession: () => 'look-around',
    savedSession: { hasProviderTurn: async () => false }
  })
  await expect(
    resolve({
      identity: {
        sessionId: record.sessionId,
        workspaceId: record.location.workspaceId,
        hostId: record.location.executionHostId,
        agent: 'bqagent',
        providerHandle: null
      },
      spawnToken: 'read-only-attempt'
    })
  ).rejects.toThrow('bqagent only supports its own tool permissions')
})
