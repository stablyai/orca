import { expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { ACP_LAUNCH_SPECS } from './acp-launch-specs'
import { createAcpStructuredLaunchResolver } from './acp-structured-launch-resolution'
import { openCodeAcpAccountBinding } from '../opencode/opencode-structured-account-home'

it.each(ACP_LAUNCH_SPECS)(
  '$agent starts a new session without probing pre-clear history',
  async (spec) => {
    const base = agentSessionRecordFixture()
    const record = {
      ...base,
      provider: spec.agent,
      accountHome:
        'accountLocatorKind' in spec.account.pin
          ? { kind: 'opencode' as const, locator: { kind: 'unmanaged' as const } }
          : { variable: spec.account.pin.accountHomeVariable, path: '/fixture/account' },
      providerContextBoundary: { operationId: 'clear', afterFence: 2, clearedAt: 100 },
      providerHandleChain: []
    }
    const account =
      spec.agent === 'opencode'
        ? openCodeAcpAccountBinding(() => ({
            list: () => {
              throw new Error('launch must not change account selection')
            },
            restoreOriginalEnvironment: () => {},
            environmentForAccount: () => {
              throw new Error('unmanaged fixture must stay unmanaged')
            }
          }))
        : spec.account
    const resolve = createAcpStructuredLaunchResolver(
      { ...spec, account },
      {
        store: { getRecord: () => record },
        readJournal: () => {
          throw new Error('pre-clear history must not be sampled')
        },
        resolveWorkspacePath: async () => '/repo/worktree',
        resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/test' }),
        resolveCommand: () => `/fixture/${spec.command}`,
        probeVersion: async () => true,
        inheritedEnv: {}
      }
    )
    const launch = await resolve({
      identity: {
        sessionId: record.sessionId,
        workspaceId: record.location.workspaceId,
        hostId: record.location.executionHostId,
        agent: spec.agent,
        providerHandle: null
      }
    })
    expect(launch.resume).toBeNull()
    expect(launch.spec.dialect).toBe(spec.dialect)
    expect(launch.args).toEqual(spec.args({ fullAccess: false, pluginDir: null }))
  }
)
