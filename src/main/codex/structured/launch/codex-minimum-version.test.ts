import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentCliVersionReader } from '../../../agent-launch/preflight/agent-cli-version-probe'
import { withSupportedCodexCli } from './codex-cli-installation-error'
import {
  createCodexStructuredLaunchResolver,
  TEST_SPAWN_TOKEN
} from '../../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { resolveProviderChildEnv } from '../../../provider-process/provider-process-launch'
import { identityFor } from '../session-lifecycle/codex-structured-session-adapter-fixture'

const readVersion = vi.fn<AgentCliVersionReader>()
beforeEach(() => {
  readVersion.mockReset()
  readVersion.mockResolvedValue({ version: '0.136.0' })
})
afterEach(() => vi.restoreAllMocks())

function record(): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(),
    provider: 'codex' as const,
    providerHandleChain: [],
    accountHome: { variable: 'CODEX_HOME' as const, path: '/account' }
  }
}

describe('Codex structured launch version admission', () => {
  it.each(['start', 'resume'] as const)(
    'checks the exact host binary and launch environment before %s',
    async (mode) => {
      const value = record()
      if (mode === 'resume') {
        value.providerHandleChain = [
          {
            linkId: 'link',
            handle: codexProviderHandle('thread'),
            origin: 'created',
            mintedAtFence: 1,
            observedAt: 1
          }
        ]
      }
      const resolve = withSupportedCodexCli(
        createCodexStructuredLaunchResolver({
          store: { getRecord: () => value, pinLaunchDirectory: vi.fn() },
          resolveCommand: () => ({
            command: '/host/bin/codex',
            prefixArgs: ['run', '--', 'codex']
          }),
          resolveEnvironment: async () => ({ PATH: '/host/bin', HOME: '/host/home' }),
          resolveLaunchArgs: () => [],
          resolveWorkspacePath: async () => '/folder'
        }),
        readVersion
      )
      readVersion.mockResolvedValue({ version: '0.135.0' })
      await expect(
        resolve({ identity: identityFor(value.sessionId), spawnToken: TEST_SPAWN_TOKEN })
      ).rejects.toThrow('0.135.0')
      const probe = readVersion.mock.calls.at(-1)?.[0]
      expect(probe?.program).toBe('/host/bin/codex')
      expect(probe?.cwd).toBe('/folder')
      expect(probe?.env?.PATH).toContain('/host/bin')
      expect(probe?.env?.HOME).toBe('/host/home')
      expect(probe?.env?.CODEX_HOME).toBe('/account')
      readVersion.mockResolvedValue({ version: '0.136.0' })
      const launch = await resolve({
        identity: identityFor(value.sessionId),
        spawnToken: TEST_SPAWN_TOKEN
      })
      expect(launch).toMatchObject({
        command: '/host/bin/codex',
        args: ['run', '--', 'codex', 'app-server']
      })
      expect(readVersion.mock.calls.at(-1)?.[0]).toEqual({
        program: launch.command,
        prefixArgs: ['run', '--', 'codex'],
        cwd: launch.cwd,
        env: resolveProviderChildEnv(launch, process.env)
      })
    }
  )
})
