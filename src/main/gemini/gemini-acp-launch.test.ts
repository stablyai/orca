import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { decideAgentLaunchMode } from '../agent-launch/agent-launch-mode'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { createAcpModelCatalogProbe } from '../acp/acp-model-catalog-probe'
import { createAcpStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import { structuredAgentRuntimeRegistration } from '../runtime/structured-agent-runtime-registrations'
import { agentChatPermissionModes } from '../../shared/agent-chat-permission-support'
import { agentSessionSignInFor } from '../../shared/agent-session-sign-in'
import { readGeminiAcpSignInLine } from './gemini-acp-dialect'

const GEMINI = acpLaunchSpecFor('gemini')!
const identity = {
  sessionId: 'gemini-chat-1',
  workspaceId: 'folder-1',
  hostId: 'local',
  agent: 'gemini',
  providerHandle: null
}

function resolver(
  options: {
    version?: string | null
    command?: string
    launchEnv?: Record<string, string>
    accountHome?: { variable: string; path: string }
  } = {}
) {
  const record = {
    ...agentSessionRecordFixture(),
    provider: 'gemini',
    providerHandleChain: [],
    accountHome: options.accountHome ?? { variable: 'GEMINI_CLI_HOME', path: '/accounts/pinned' }
  }
  return createAcpStructuredLaunchResolver(GEMINI, {
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    readJournal: () => null,
    resolveWorkspacePath: async () => '/workspace/folder',
    resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/host' }),
    resolveLaunchEnv: () => options.launchEnv ?? {},
    resolveCommandSettings: () => ({ agentCmdOverrides: { gemini: options.command ?? '' } }),
    resolveCommand: () => '/installed/gemini',
    inheritedEnv: {},
    probeVersion: async () => ({
      version: options.version === undefined ? '0.65.0' : options.version
    })
  })
}

describe('original Gemini CLI ACP launch', () => {
  it('launches the registered agent as a native chat in folder and worktree workspaces', () => {
    const registration = structuredAgentRuntimeRegistration('gemini')!
    expect(registration.definition.accountHomeVariable).toBe('GEMINI_CLI_HOME')
    expect(registration.definition.restingOptions.fallbackModels()).toBeNull()
    expect(registration.definition.restingOptions.acceptsKey('effort')).toBe(false)
    expect(agentChatPermissionModes('gemini')?.modes).toEqual(['ask', 'full-access'])
    for (const workspaceKind of ['folder', 'git-worktree'] as const) {
      expect(
        decideAgentLaunchMode({
          placement: { agent: 'gemini', workspaceKind },
          settings: { agentDefaultSurface: 'chat' }
        }).mode
      ).toBe('structured')
    }
    expect(
      registration.supportsLocation({
        executionHostId: 'ssh:another-host',
        wslDistro: null,
        workspaceId: 'folder-1',
        workspaceKind: 'folder'
      })
    ).toBe(false)
  })

  it('pins the home root the original CLI appends .gemini to, without creating it', async () => {
    await expect(
      GEMINI.account.resolve({
        launchEnv: { GEMINI_CLI_HOME: '/accounts/work' },
        stateDirectory: '/orca-data'
      })
    ).resolves.toEqual({ variable: 'GEMINI_CLI_HOME', path: '/accounts/work' })
    await expect(
      GEMINI.account.resolve({
        launchEnv: { GEMINI_CLI_HOME: '' },
        stateDirectory: '/orca-data'
      })
    ).resolves.toEqual({ variable: 'GEMINI_CLI_HOME', path: homedir() })
    expect(GEMINI.account.prepare).toBeUndefined()
    for (const permissionMode of ['ask', 'full-access'] as const) {
      const launch = await resolver({
        launchEnv: {
          GEMINI_CLI_HOME: '/accounts/other',
          GEMINI_API_KEY: 'test-key',
          GOOGLE_APPLICATION_CREDENTIALS: '/accounts/adc.json',
          GOOGLE_CLOUD_PROJECT: 'test-project'
        }
      })({ identity, permissionMode, spawnToken: 'token' })
      expect(launch).toMatchObject({
        command: '/installed/gemini',
        args: ['--acp', '--approval-mode', 'default'],
        cwd: '/workspace/folder',
        fullAccess: permissionMode === 'full-access',
        env: {
          GEMINI_CLI_HOME: '/accounts/pinned',
          GEMINI_API_KEY: 'test-key',
          GOOGLE_APPLICATION_CREDENTIALS: '/accounts/adc.json',
          GOOGLE_CLOUD_PROJECT: 'test-project',
          NO_BROWSER: 'true'
        }
      })
    }
  })

  it('keeps an explicit Gemini executable and refuses an invalid one without stock fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-gemini-command-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const command = join(
      directory,
      process.platform === 'win32' ? 'gemini-custom.cmd' : 'gemini-custom'
    )
    await writeFile(command, '#!/bin/sh\n', { mode: 0o700 })
    await expect(resolver({ command })({ identity })).resolves.toMatchObject({
      command,
      args: ['--acp', '--approval-mode', 'default']
    })
    await expect(
      resolver({ command: join(directory, 'missing-gemini') })({ identity })
    ).rejects.toMatchObject({ reason: 'agentCommandNotRunnable' })
    await expect(
      resolver({ accountHome: { variable: 'GEMINI_HOME', path: '/accounts/agy' } })({ identity })
    ).rejects.toThrow(/pin GEMINI_CLI_HOME/)
  })

  it.each(['0.64.0', '0.65.0-rc.1'])(
    'refuses unverified older original CLI %s',
    async (version) => {
      await expect(resolver({ version })({ identity })).rejects.toMatchObject({
        installation: { agent: 'gemini', installedVersion: version, minimumVersion: '0.65.0' }
      })
    }
  )

  it('never spawns, signs in or creates a disposable session just to get a model menu', async () => {
    const resolveEnvironment = vi.fn(async () => ({}))
    const connect = vi.fn()
    const probe = createAcpModelCatalogProbe(GEMINI, {
      resolveEnvironment,
      connect,
      dataDirectory: '/orca-data'
    })
    await expect(probe({ variable: 'GEMINI_CLI_HOME', path: '/accounts/pinned' })).rejects.toThrow(
      'lists its models only in a signed-in session'
    )
    expect(resolveEnvironment).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('directs sign-in to the original CLI and detects manual OAuth before it consumes the protocol', () => {
    expect(agentSessionSignInFor('gemini')).toMatchObject({
      loginCommand: ['gemini'],
      slashCommand: '/auth'
    })
    const url =
      'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode'
    expect(readGeminiAcpSignInLine(url)).toBe(url)
    expect(readGeminiAcpSignInLine('ordinary stderr')).toBeUndefined()
    expect(
      readGeminiAcpSignInLine(
        'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https://elsewhere.test'
      )
    ).toBeNull()
  })
})
