import { beforeEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../shared/codex-cli-installation'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { readWholeAgentSessionFailureFact } from '../../shared/agent-session-failure'
import { resolveAgentLaunchCommand } from '../../shared/tui-agent-launch-command'
import { readCodexCliInstallation } from '../preflight/codex-cli-installation'
import {
  failedAcquisitionRefusal,
  failedAcquisitionSettlement
} from '../native-chat/agent-session-wire/structured-agent-session-failed-create-refusal'
import { structuredAgentSessionStartFailure } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import { CodexCliInstallationError, requireSupportedCodexCli } from './codex-cli-installation-error'
import { createCodexStructuredLaunchResolver } from './codex-structured-launch-resolution'
import { identityFor } from './codex-structured-session-adapter-fixture'

vi.mock('../preflight/codex-cli-installation', () => ({ readCodexCliInstallation: vi.fn() }))
beforeEach(() => {
  vi.mocked(readCodexCliInstallation).mockReset()
  vi.mocked(readCodexCliInstallation).mockResolvedValue(codexCliInstallation(true, '0.136.0'))
})

function record(): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(),
    provider: 'codex' as const,
    providerHandleChain: [],
    accountHome: { variable: 'CODEX_HOME' as const, path: '/account' }
  }
}

describe('Codex structured launch version admission', () => {
  it.each([null, '0.100.0', '0.135.0'])(
    'refuses %s with concise repair copy and both version facts',
    async (version) => {
      vi.mocked(readCodexCliInstallation).mockResolvedValue(
        codexCliInstallation(version !== null, version)
      )
      const caught = await requireSupportedCodexCli({ program: '/execution-host/codex' }).catch(
        (error: unknown) => error
      )
      expect(caught).toBeInstanceOf(CodexCliInstallationError)
      const wording = { record: record(), newSession: true }
      const result = failedAcquisitionRefusal(caught, wording)
      expect(result?.refusal.message).toBe(
        version === null
          ? "Codex isn't installed."
          : `Codex ${version} is too old for chats. Update to 0.136.0 or newer.`
      )
      expect(result?.refusal.message).not.toContain('Settings → Agents')
      expect(result?.refusal.message).not.toContain('codex update')
      expect(failedAcquisitionSettlement(caught, wording).exitProof).toBe('processless')
      const failure = structuredAgentSessionStartFailure({ error: caught })
      expect(failure.reason).toBe(result?.refusal.message)
      expect(readWholeAgentSessionFailureFact(failure.rejection)).toEqual(failure.rejection)
      if (!result) {
        throw new Error('Expected refusal')
      }
      expect(
        structuredAgentSessionStartFailure({ refusal: result.refusal, newSession: true }).reason
      ).toBe(failure.reason)
    }
  )

  it('allows an unknown version with a log line', async () => {
    vi.mocked(readCodexCliInstallation).mockResolvedValue(codexCliInstallation(true, null))
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(requireSupportedCodexCli({ program: '/host/codex' })).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('allowing structured chat'))
    log.mockRestore()
  })

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
      const resolve = createCodexStructuredLaunchResolver({
        store: { getRecord: () => value, pinLaunchDirectory: vi.fn() },
        resolveCommand: () => '/host/bin/codex',
        resolveEnvironment: async () => ({ PATH: '/host/bin', HOME: '/host/home' }),
        resolveLaunchArgs: () => [],
        resolveWorkspacePath: async () => '/folder',
        resolveRollout: async () => null
      })
      vi.mocked(readCodexCliInstallation).mockResolvedValue(codexCliInstallation(true, '0.135.0'))
      await expect(resolve({ identity: identityFor(value.sessionId) })).rejects.toThrow('0.135.0')
      const probe = vi.mocked(readCodexCliInstallation).mock.calls.at(-1)?.[0]
      expect(probe?.program).toBe('/host/bin/codex')
      expect(probe?.cwd).toBe('/folder')
      expect(probe?.env?.PATH).toContain('/host/bin')
      expect(probe?.env?.HOME).toBe('/host/home')
      expect(probe?.env?.CODEX_HOME).toBe('/account')
      vi.mocked(readCodexCliInstallation).mockResolvedValue(codexCliInstallation(true, '0.136.0'))
      await expect(resolve({ identity: identityFor(value.sessionId) })).resolves.toMatchObject({
        command: '/host/bin/codex',
        args: ['app-server']
      })
    }
  )

  it.each(['start', 'resume'] as const)(
    'admits the workspace-selected version on %s',
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
      vi.mocked(readCodexCliInstallation).mockImplementation(async (input) =>
        codexCliInstallation(true, input.cwd === '/workspace' ? '0.136.0' : '0.135.0')
      )
      const resolve = createCodexStructuredLaunchResolver({
        store: { getRecord: () => value, pinLaunchDirectory: vi.fn() },
        resolveCommand: () => '/host/project-aware-codex',
        resolveEnvironment: async () => ({ PATH: '/host/bin' }),
        resolveLaunchArgs: () => [],
        resolveWorkspacePath: async () => '/workspace',
        resolveRollout: async () => null
      })
      expect((await resolve({ identity: identityFor(value.sessionId) })).cwd).toBe('/workspace')
    }
  )

  it.each(['posix', 'powershell', 'cmd'] as const)(
    'leaves terminal Codex launch unchanged in %s',
    (shell) => {
      vi.mocked(readCodexCliInstallation).mockResolvedValue(codexCliInstallation(true, '0.135.0'))
      expect(
        resolveAgentLaunchCommand({
          agent: 'codex',
          cmdOverrides: {},
          platform: shell === 'posix' ? 'linux' : 'win32',
          shell,
          agentArgs: '--model chosen'
        })
      ).toMatchObject({
        ok: true,
        command: shell === 'cmd' ? 'codex "--model" "chosen"' : "codex '--model' 'chosen'"
      })
      expect(readCodexCliInstallation).not.toHaveBeenCalled()
    }
  )
})
