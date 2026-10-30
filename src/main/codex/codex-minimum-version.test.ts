import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { readWholeAgentSessionFailureFact } from '../../shared/agent-session-failure'
import { resolveAgentLaunchCommand } from '../../shared/tui-agent-launch-command'
import type { AgentCliVersionReader } from '../agent-cli-version-probe'
import { AgentCliInstallationError } from '../native-chat/agent-cli-installation-error'
import {
  failedAcquisitionRefusal,
  failedAcquisitionSettlement
} from '../native-chat/agent-session-wire/structured-agent-session-failed-create-refusal'
import { structuredAgentSessionStartFailure } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import { requireSupportedCodexCli, withSupportedCodexCli } from './codex-cli-installation-error'
import {
  createCodexStructuredLaunchResolver,
  TEST_SPAWN_TOKEN
} from '../runtime/structured-agent-launch-composition.test-support'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'
import { identityFor } from './codex-structured-session-adapter-fixture'
import { openCodexAppServerConnection } from './codex-app-server-connection'

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
  it.each(['0.100.0', '0.135.0'])(
    'refuses %s with concise repair copy and both version facts',
    async (version) => {
      readVersion.mockResolvedValue({ version })
      const caught = await requireSupportedCodexCli(
        { program: '/execution-host/codex' },
        readVersion
      ).catch((error: unknown) => error)
      expect(caught).toBeInstanceOf(AgentCliInstallationError)
      const wording = { record: record(), newSession: true }
      const result = failedAcquisitionRefusal(caught, wording)
      expect(result?.refusal.message).toBe(
        `Codex ${version} is too old for chats. Update to 0.136.0 or newer.`
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

  it('leaves a missing Codex to the existing spawn refusal', async () => {
    readVersion.mockResolvedValue({ version: null, started: false })
    await expect(
      requireSupportedCodexCli({ program: 'codex' }, readVersion)
    ).resolves.toBeUndefined()
  })

  it('reports Windows ENOENT through the existing not-found failure with one explanation', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    readVersion.mockResolvedValue({ version: null, started: false })
    await requireSupportedCodexCli({ program: 'codex.exe' }, readVersion)
    const child = createFakePipedChild()
    Object.assign(child, { pid: undefined })
    const opening = openCodexAppServerConnection(
      { command: 'codex.exe', args: ['app-server'] },
      {},
      () => child
    ).catch((error: unknown) => error)
    child.emit(
      'error',
      Object.assign(new Error('spawn codex.exe ENOENT'), { code: 'ENOENT', path: 'codex.exe' })
    )
    child.emit('close', -2, null)
    const failure = structuredAgentSessionStartFailure(
      { error: await opening },
      { agentName: 'Codex' }
    )
    expect(failure.rejection.kind).toBe('cliMissing')
    expect(failure.reason).toBe(
      "Codex wasn't found on the computer running this chat. Install it, or check its Command in Settings → Agents."
    )
  })

  it('allows an unknown version with a log line', async () => {
    readVersion.mockResolvedValue({ version: null })
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      requireSupportedCodexCli({ program: '/host/codex' }, readVersion)
    ).resolves.toBeUndefined()
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
      readVersion.mockImplementation(async (input) => ({
        version: input.cwd === '/workspace' ? '0.136.0' : '0.135.0'
      }))
      const resolve = withSupportedCodexCli(
        createCodexStructuredLaunchResolver({
          store: { getRecord: () => value, pinLaunchDirectory: vi.fn() },
          resolveCommand: () => ({ command: '/host/project-aware-codex', prefixArgs: [] }),
          resolveEnvironment: async () => ({ PATH: '/host/bin' }),
          resolveLaunchArgs: () => [],
          resolveWorkspacePath: async () => '/workspace'
        }),
        readVersion
      )
      expect(
        (await resolve({ identity: identityFor(value.sessionId), spawnToken: TEST_SPAWN_TOKEN }))
          .cwd
      ).toBe('/workspace')
    }
  )

  it.each(['posix', 'powershell', 'cmd'] as const)(
    'leaves terminal Codex launch unchanged in %s',
    (shell) => {
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
        command:
          shell === 'cmd'
            ? 'codex "--model" "chosen"'
            : shell === 'posix'
              ? "codex '-c' 'disable_paste_burst=true' '--model' 'chosen'"
              : "codex '--model' 'chosen'"
      })
    }
  )
})
