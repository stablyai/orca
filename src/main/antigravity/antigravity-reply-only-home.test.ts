import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REPLY_ONLY_REFUSAL } from '../bots/bot-look-around-policy'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { AGY_SKIP_PERMISSIONS_FLAG, antigravityHostAccountHome } from './antigravity-host-acp'
import {
  ANTIGRAVITY_REPLY_ONLY_DENY_RULES,
  antigravityReplyOnlyHookCommand,
  antigravityReplyOnlyWindowsScript,
  prepareAntigravityReplyOnlyLaunch
} from './antigravity-reply-only-home'
import {
  acpStructuredPermissionHandler,
  acpStructuredRequestHandler
} from '../acp/requests/acp-structured-permission-handler'
import { ACP_FORM_ELICITATION_METHOD } from '../acp/requests/acp-form-elicitation'
import { acpLaunchPermission } from '../acp/launch/acp-launch-permission-modes'
import { acquireAcpStructuredSession } from '../acp/session/acp-structured-acquire'
import { initializeAcpStructuredSession } from '../acp/session/start/acp-structured-handshake'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import type { AcpStructuredChild } from '../acp/session/children/acp-structured-child'
import type { AcpStructuredPrompts } from '../acp/requests/acp-structured-prompts'
import { createAcpStructuredLaunchResolver } from '../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'

const store = vi.hoisted((): { saved: string | null } => ({ saved: 'saved-key' }))
vi.mock('./antigravity-chat-api-key-store', () => ({
  readAntigravityChatApiKey: async () => store.saved,
  hasAntigravityChatApiKey: async () => store.saved !== null
}))

const { ANTIGRAVITY_LAUNCH_SPEC } = await import('./antigravity-acp-launch-spec')
const { antigravityAgyOrcaAccountHome } = await import('./antigravity-agy-orca-home')
const { acpStructuredLaunchPart } = await import('../acp/launch/acp-structured-launch-resolution')
const { SessionMcpTools } = await import('../mcp-servers/session-mcp-tools')
const { NO_LINKED_SKILLS } = await import('../native-chat/native-chat-skill-roots')

const folders: string[] = []
afterEach(() => {
  folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
  store.saved = 'saved-key'
})

function userHomeEnv(userHome: string, extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: userHome, USERPROFILE: userHome, ...extra }
}

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  folders.push(path)
  return path
}

function geminiDirFromArgs(args: readonly string[]): string {
  const index = args.indexOf('--gemini-dir')
  expect(index).toBeGreaterThan(-1)
  return args[index + 1]
}

describe('Antigravity reply-only home isolation', () => {
  it('isolates host settings, strips allow rules, writes deny-all PreToolUse hook, and cleans up on release', async () => {
    const dataDirectory = tempDir('agy-reply-only-data-')
    const userHome = tempDir('agy-reply-only-user-')
    const hostAppDir = join(userHome, '.gemini', 'antigravity-cli')
    mkdirSync(hostAppDir, { recursive: true })
    writeFileSync(
      join(hostAppDir, 'settings.json'),
      JSON.stringify({
        toolPermission: 'always-proceed',
        agentMode: 'accept-edits',
        allowNonWorkspaceAccess: true,
        permissions: { allow: ['command(*)', 'write_file(*)'] },
        trustedWorkspaces: ['/Users/owner'],
        statusLine: { command: 'evil.sh' },
        modelProvider: 'gemini',
        useG1Credits: true
      })
    )
    writeFileSync(
      join(hostAppDir, 'antigravity-oauth-token'),
      JSON.stringify({ access_token: 'tok-1' })
    )

    const prepared = await prepareAntigravityReplyOnlyLaunch({
      mode: 'reply-only',
      dataDirectory,
      env: userHomeEnv(userHome)
    })

    expect(prepared.args).not.toContain(AGY_SKIP_PERMISSIONS_FLAG)
    expect(prepared.args).toContain('--include-default-customizations=false')
    expect(prepared.args).toContain('--app-data-dir')
    expect(prepared.args).toContain(ANTIGRAVITY_ACP_HOME)

    const isolatedDir = geminiDirFromArgs(prepared.args)
    expect(isolatedDir).not.toContain(join(userHome, '.gemini'))
    expect(prepared.cwd).toBe(join(isolatedDir, 'work'))
    expect(existsSync(prepared.cwd)).toBe(true)
    expect(readdirSync(prepared.cwd)).toEqual([])

    const settings = JSON.parse(
      readFileSync(join(isolatedDir, ANTIGRAVITY_ACP_HOME, 'settings.json'), 'utf8')
    )
    expect(settings).toEqual({
      modelProvider: 'gemini',
      useG1Credits: true,
      agentMode: '',
      toolPermission: 'strict',
      allowNonWorkspaceAccess: false,
      permissions: { deny: [...ANTIGRAVITY_REPLY_ONLY_DENY_RULES] }
    })

    const hooks = JSON.parse(readFileSync(join(isolatedDir, 'config', 'hooks.json'), 'utf8'))
    expect(hooks['orca-reply-only'].PreToolUse).toEqual([
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: antigravityReplyOnlyHookCommand(
              process.platform,
              join(isolatedDir, 'config', 'reply-only-deny.cmd')
            )
          }
        ]
      }
    ])

    expect(
      JSON.parse(
        readFileSync(join(isolatedDir, ANTIGRAVITY_ACP_HOME, 'antigravity-oauth-token'), 'utf8')
      )
    ).toEqual({ access_token: 'tok-1' })

    await prepared.release()
    expect(existsSync(isolatedDir)).toBe(false)
    expect(existsSync(prepared.cwd)).toBe(false)
  })

  it('preserves Orca-home API key auth without copying host OAuth tokens', async () => {
    const dataDirectory = tempDir('agy-reply-only-key-data-')
    const userHome = tempDir('agy-reply-only-key-user-')
    const hostAppDir = join(userHome, '.gemini', 'antigravity-cli')
    mkdirSync(hostAppDir, { recursive: true })
    writeFileSync(
      join(hostAppDir, 'antigravity-oauth-token'),
      JSON.stringify({ access_token: 'should-not-copy' })
    )

    const prepared = await prepareAntigravityReplyOnlyLaunch({
      mode: 'reply-only',
      dataDirectory,
      env: userHomeEnv(userHome, { GEMINI_API_KEY: 'saved-key' }),
      antigravityChatAuth: { method: 'gemini-api-key' }
    })
    const isolatedDir = geminiDirFromArgs(prepared.args)
    const settings = JSON.parse(
      readFileSync(join(isolatedDir, ANTIGRAVITY_ACP_HOME, 'settings.json'), 'utf8')
    )
    expect(settings.auth).toEqual({ type: 'gemini-api-key' })
    expect(settings.toolPermission).toBe('strict')
    expect(existsSync(join(isolatedDir, ANTIGRAVITY_ACP_HOME, 'antigravity-oauth-token'))).toBe(
      false
    )
    await prepared.release()
  })

  it('formats platform-native deny-all hook commands for POSIX and Windows paths', () => {
    const expectedJson = JSON.stringify({ decision: 'deny', reason: REPLY_ONLY_REFUSAL })
    const posix = antigravityReplyOnlyHookCommand('darwin')
    expect(posix).toBe(`printf '%s\\n' '${expectedJson}'`)

    const batchScript = antigravityReplyOnlyWindowsScript()
    expect(batchScript).toBe(
      `@echo off\r\nsetlocal DisableDelayedExpansion\r\necho ${expectedJson}\r\nexit /b 0\r\n`
    )

    const safeWinPath =
      'C:\\Users\\alice\\AppData\\Roaming\\Orca\\acp-reply-only\\antigravity\\run-12345678-1234-4123-8123-123456789abc\\config\\reply-only-deny.cmd'
    expect(antigravityReplyOnlyHookCommand('win32', safeWinPath)).toBe(
      'C:/Users/alice/AppData/Roaming/Orca/acp-reply-only/antigravity/run-12345678-1234-4123-8123-123456789abc/config/reply-only-deny.cmd'
    )

    const spacedWinPath =
      'C:\\Users\\Alice Smith\\AppData\\Roaming\\Orca\\acp-reply-only\\antigravity\\run-12345678-1234-4123-8123-123456789abc\\config\\reply-only-deny.cmd'
    const spacedCmd = antigravityReplyOnlyHookCommand('win32', spacedWinPath)
    expect(spacedCmd).toContain('powershell.exe -NoProfile -EncodedCommand ')
    const decodedSpaced = Buffer.from(spacedCmd.split(' -EncodedCommand ')[1], 'base64').toString(
      'utf16le'
    )
    expect(decodedSpaced).toContain(`-LiteralPath '${spacedWinPath}'`)
    expect(decodedSpaced).toContain(`Write-Output '${expectedJson}'`)

    const unicodeWinPath =
      'C:\\Users\\张\\AppData\\Roaming\\Orca\\acp-reply-only\\antigravity\\run-12345678-1234-4123-8123-123456789abc\\config\\reply-only-deny.cmd'
    const unicodeCmd = antigravityReplyOnlyHookCommand('win32', unicodeWinPath)
    const decodedUnicode = Buffer.from(unicodeCmd.split(' -EncodedCommand ')[1], 'base64').toString(
      'utf16le'
    )
    expect(decodedUnicode).toContain("$env:PSExecutionPolicyPreference='Bypass'")
    expect(decodedUnicode).toContain(`-LiteralPath '${unicodeWinPath}'`)

    const uncWinPath =
      '\\\\server\\share\\Orca\\acp-reply-only\\antigravity\\run-12345678-1234-4123-8123-123456789abc\\config\\reply-only-deny.cmd'
    const uncCmd = antigravityReplyOnlyHookCommand('win32', uncWinPath)
    expect(uncCmd).toContain('powershell.exe -NoProfile -EncodedCommand ')
    expect(uncCmd.startsWith('//server/')).toBe(false)

    expect(() => antigravityReplyOnlyHookCommand('win32')).toThrow(
      'Windows reply-only hook command requires a batch script path'
    )
  })

  it('writes config/reply-only-deny.cmd and reads host auth from USERPROFILE when preparing a win32 launch', async () => {
    const dataDirectory = tempDir('agy-reply-only-win-data-')
    const userProfile = tempDir('agy-reply-only-win-profile-')
    const hostAppDir = join(userProfile, '.gemini', 'antigravity-cli')
    mkdirSync(hostAppDir, { recursive: true })
    writeFileSync(
      join(hostAppDir, 'settings.json'),
      JSON.stringify({
        toolPermission: 'always-proceed',
        modelProvider: 'gemini'
      })
    )
    writeFileSync(
      join(hostAppDir, 'antigravity-oauth-token'),
      JSON.stringify({ access_token: 'win-tok-1' })
    )

    const prepared = await prepareAntigravityReplyOnlyLaunch({
      mode: 'reply-only',
      dataDirectory,
      env: { USERPROFILE: userProfile },
      platform: 'win32'
    })
    const isolatedDir = geminiDirFromArgs(prepared.args)
    const batchPath = join(isolatedDir, 'config', 'reply-only-deny.cmd')
    expect(readFileSync(batchPath, 'utf8')).toBe(antigravityReplyOnlyWindowsScript())
    const settings = JSON.parse(
      readFileSync(join(isolatedDir, ANTIGRAVITY_ACP_HOME, 'settings.json'), 'utf8')
    )
    expect(settings.modelProvider).toBe('gemini')
    expect(settings.toolPermission).toBe('strict')
    expect(
      JSON.parse(
        readFileSync(join(isolatedDir, ANTIGRAVITY_ACP_HOME, 'antigravity-oauth-token'), 'utf8')
      )
    ).toEqual({ access_token: 'win-tok-1' })
    await prepared.release()
    expect(existsSync(isolatedDir)).toBe(false)
  })

  it('refuses look-around mode on Antigravity (fail-closed)', async () => {
    await expect(
      prepareAntigravityReplyOnlyLaunch({
        mode: 'look-around',
        dataDirectory: tempDir('agy-reply-only-look-'),
        env: userHomeEnv(tempDir('agy-reply-only-home-'))
      })
    ).rejects.toThrow('Antigravity does not support look-around read-only sessions')
  })
})

describe('acpStructuredLaunchPart reply-only enforcement', () => {
  function makeBasis(input: {
    home: ReturnType<typeof antigravityHostAccountHome>
    cwd: string
    userHome: string
    readOnly: 'reply-only' | 'look-around' | null
    permissionMode?: 'ask' | 'accept-edits' | 'full-access'
    antigravityChatAuth?: { method: 'gemini-api-key' }
  }) {
    const env = userHomeEnv(input.userHome, { PATH: '/usr/bin' })
    return {
      record: {
        sessionId: 'tidy-1',
        provider: 'antigravity',
        accountHome: input.home,
        providerHandleChain: [],
        options: { model: 'gemini-4-neon' }
      },
      launchDirectory: async () => input.cwd,
      baseEnvironment: async () => env,
      launchEnv: () => ({}),
      environment: async () => env,
      visuals: async () => null,
      instructions: async () => 'Bot preamble',
      toolServers: async () => SessionMcpTools.none,
      linkedSkills: async () => NO_LINKED_SKILLS,
      linkedSkillsRefused: () => {},
      commandSettings: () =>
        input.antigravityChatAuth ? { antigravityChatAuth: input.antigravityChatAuth } : {},
      permissionMode: input.permissionMode ?? 'ask',
      readOnly: input.readOnly
    }
  }

  const testIdentity = {
    sessionId: 'tidy-1',
    workspaceId: 'w1',
    hostId: 'local',
    agent: 'antigravity' as const,
    providerHandle: null
  }

  it('launches Antigravity reply-only sessions with isolated args and never full access', async () => {
    const dataDirectory = tempDir('agy-launch-data-')
    const userHome = tempDir('agy-launch-user-')
    const cwd = tempDir('agy-launch-cwd-')
    const part = acpStructuredLaunchPart(ANTIGRAVITY_LAUNCH_SPEC, {
      savedSession: { hasProviderTurn: async () => false },
      resolveCommand: () => '/opt/agy/bin/agy',
      probeVersion: async () => ({ version: '1.5.16' }),
      dataDirectory
    })
    const composed = await part(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test basis covers fields read by acpStructuredLaunchPart.
      makeBasis({
        home: antigravityAgyOrcaAccountHome(dataDirectory),
        cwd,
        userHome,
        readOnly: 'reply-only',
        permissionMode: 'full-access',
        antigravityChatAuth: { method: 'gemini-api-key' }
      }) as unknown as Parameters<typeof part>[0],
      testIdentity
    )

    expect(composed.launch.fullAccess).toBe(false)
    expect(composed.launch.readOnly).toBe('reply-only')
    expect(composed.launch.args).not.toContain(AGY_SKIP_PERMISSIONS_FLAG)
    expect(composed.launch.args.filter((arg) => arg === '--gemini-dir')).toHaveLength(1)
    expect(composed.launch.args).toContain('--include-default-customizations=false')
    expect(composed.launch.mcpServers).toBeUndefined()

    const isolatedDir = geminiDirFromArgs(composed.launch.args)
    expect(isolatedDir).not.toBe(join(dataDirectory, 'antigravity-agy-chat'))
    expect(composed.cwd).toBe(join(isolatedDir, 'work'))
    expect(composed.cwd).not.toBe(cwd)
    expect(readdirSync(composed.cwd!)).toEqual([])
    expect(existsSync(join(isolatedDir, 'config', 'hooks.json'))).toBe(true)

    await composed.launch.release?.()
    expect(existsSync(isolatedDir)).toBe(false)
  })

  it('routes reply-only Antigravity launches to the isolated empty cwd for both process spawn and ACP session/new while normal launches keep workspace cwd', async () => {
    const dataDirectory = tempDir('agy-cwd-data-')
    const userHome = tempDir('agy-cwd-user-')
    const botWorkspace = tempDir('agy-cwd-bot-workspace-')
    mkdirSync(join(botWorkspace, '.gemini'), { recursive: true })
    writeFileSync(join(botWorkspace, '.gemini', 'hooks.json'), '{"workspace":"untrusted"}')

    const record: AgentSessionRecord = {
      schemaVersion: 2,
      sessionId: 'tidy-cwd-1',
      provider: 'antigravity',
      accountHome: antigravityHostAccountHome(userHome),
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'w1',
        workspaceKind: 'folder'
      },
      launchDirectory: botWorkspace,
      providerHandleChain: [],
      options: { model: 'gemini-4-neon' },
      lease: {
        sessionId: 'tidy-cwd-1',
        runtimeKind: 'native',
        runtimeFence: 1,
        handoffStage: null,
        provenHandleLinkId: null,
        ownerProcess: null,
        reservedSpawnToken: null,
        leaseDeadlineAt: 0,
        lastRenewedAt: 0,
        handoffOperationId: null,
        claimKeyId: 'k1',
        claimStatus: 'released',
        unreconciled: false,
        deathEvidence: null
      },
      createdAt: 1,
      updatedAt: 1
    }
    const store = {
      getRecord: (id: string) => (id === record.sessionId ? record : null),
      pinLaunchDirectory: async () => record
    }
    const identity = {
      sessionId: record.sessionId,
      workspaceId: 'w1',
      hostId: 'local',
      agent: 'antigravity' as const,
      providerHandle: null
    }

    const normalResolve = createAcpStructuredLaunchResolver(ANTIGRAVITY_LAUNCH_SPEC, {
      store,
      resolveWorkspacePath: async () => botWorkspace,
      resolveEnvironment: async () => userHomeEnv(userHome, { PATH: '/usr/bin' }),
      resolveCommand: () => '/opt/agy/bin/agy',
      probeVersion: async () => ({ version: '1.5.16' }),
      savedSession: { hasProviderTurn: async () => false },
      dataDirectory,
      readOnlySession: () => null
    })
    const normalLaunch = await normalResolve({ identity, spawnToken: 'tok-normal' })
    expect(normalLaunch.cwd).toBe(botWorkspace)
    await normalLaunch.release?.()

    const replyOnlyResolve = createAcpStructuredLaunchResolver(ANTIGRAVITY_LAUNCH_SPEC, {
      store,
      resolveWorkspacePath: async () => botWorkspace,
      resolveEnvironment: async () => userHomeEnv(userHome, { PATH: '/usr/bin' }),
      resolveCommand: () => '/opt/agy/bin/agy',
      probeVersion: async () => ({ version: '1.5.16' }),
      savedSession: { hasProviderTurn: async () => false },
      dataDirectory,
      readOnlySession: () => 'reply-only'
    })

    let spawnedCwd: string | undefined
    let handshakeCwd: string | undefined
    let isolatedDir: string | undefined
    let onExitCallback: (() => void) | undefined

    const connectionStub = {
      pid: 4242,
      spawned: Promise.resolve(),
      exited: false,
      closed: false,
      stderrTail: () => '',
      subscribe: () => () => {},
      onExit: (cb: () => void) => {
        onExitCallback = cb
        return () => {}
      },
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
      start: async (
        params: { cwd: string },
        acceptSession?: (accepted: { kind: 'new'; sessionId: string; response: object }) => void
      ) => {
        handshakeCwd = params.cwd
        const started = { kind: 'new' as const, sessionId: 'agy-isolated-1', response: {} }
        acceptSession?.(started)
        return started
      },
      setConfigOption: async (
        id: string,
        value: unknown,
        _meta: unknown,
        received?: (response: { configOptions: { id: string; currentValue: unknown }[] }) => void
      ) => {
        received?.({ configOptions: [{ id, currentValue: value }] })
        return { configOptions: [{ id, currentValue: value }] }
      }
    }

    const eventsStub = {
      tryAppendTransition: () => ({ accepted: true }),
      publish: () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub covers event sink methods called during ACP session open.
    const events = eventsStub as unknown as Parameters<
      typeof acquireAcpStructuredSession
    >[0]['acquire']['events']
    const depsStub = {
      spec: { ...ANTIGRAVITY_LAUNCH_SPEC, privateTempDirectory: undefined },
      dataDirectory,
      resolveLaunch: async (request: Parameters<typeof replyOnlyResolve>[0]) => {
        const resolved = await replyOnlyResolve(request)
        isolatedDir = geminiDirFromArgs(resolved.args)
        return resolved
      },
      connect: (launch: { cwd: string }) => {
        spawnedCwd = launch.cwd
        return connectionStub
      },
      readProcessStartTime: async () => ({ status: 'present', startTime: '100' })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub covers adapter deps read by acquireAcpStructuredSession on new session open.
    const deps = depsStub as unknown as Parameters<typeof acquireAcpStructuredSession>[0]['deps']

    const { session } = await acquireAcpStructuredSession({
      acquire: {
        identity,
        fence: 1,
        spawnToken: 'tok-reply-only',
        permissionMode: 'full-access',
        events
      },
      deps,
      generation: 'gen-isolated',
      abandoned: () => false,
      track: () => {},
      onExit: () => {},
      onConnectionLost: () => {},
      onSettled: () => {},
      forceClose: () => {}
    })

    const opened = await session.open(new AbortController().signal)
    expect(opened.link?.handle.nativeId).toBe('agy-isolated-1')
    expect(isolatedDir).toBeDefined()
    const expectedWorkDir = join(isolatedDir!, 'work')
    expect(spawnedCwd).toBe(expectedWorkDir)
    expect(handshakeCwd).toBe(expectedWorkDir)
    expect(spawnedCwd).not.toBe(botWorkspace)
    expect(handshakeCwd).not.toBe(botWorkspace)
    expect(readdirSync(expectedWorkDir)).toEqual([])

    onExitCallback?.()
    await vi.waitFor(() => {
      expect(existsSync(isolatedDir!)).toBe(false)
    })
  })

  it('fails closed when an ACP spec without prepareReadOnlyLaunch enters reply-only mode', async () => {
    const dataDirectory = tempDir('acp-fail-closed-data-')
    const userHome = tempDir('acp-fail-closed-user-')
    const cwd = tempDir('acp-fail-closed-cwd-')
    const unguardedSpec: AcpLaunchSpec = {
      ...ANTIGRAVITY_LAUNCH_SPEC,
      prepareReadOnlyLaunch: undefined,
      hostBackend: undefined
    }
    const part = acpStructuredLaunchPart(unguardedSpec, {
      savedSession: { hasProviderTurn: async () => false },
      resolveCommand: () => '/opt/agy/bin/agy',
      probeVersion: async () => ({ version: '1.5.16' }),
      dataDirectory
    })

    await expect(
      part(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test basis covers fields read by acpStructuredLaunchPart.
        makeBasis({
          home: antigravityHostAccountHome(userHome),
          cwd,
          userHome,
          readOnly: 'reply-only'
        }) as unknown as Parameters<typeof part>[0],
        testIdentity
      )
    ).rejects.toThrow('does not support reply-only sessions')
  })
})

describe('acpStructuredPermissionHandler in reply-only mode', () => {
  it('immediately rejects permission requests without opening prompts or auto-approving', async () => {
    const promptHandle = vi.fn()
    const childStub = {
      lane: {},
      turns: { acceptsRequests: true },
      permission: 'full-access',
      readOnly: 'reply-only'
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: permission and request handlers read only lane, turns.acceptsRequests, permission, and readOnly.
    const child = childStub as unknown as AcpStructuredChild
    const promptsStub = { handle: promptHandle }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reply-only handlers reject before touching prompts.handle.
    const prompts = promptsStub as unknown as AcpStructuredPrompts
    const handler = acpStructuredPermissionHandler(
      () => child,
      { ...ANTIGRAVITY_LAUNCH_SPEC, permissionModeConfig: undefined },
      prompts
    )
    const reply = handler(
      {
        sessionId: 's1',
        toolCall: { toolCallId: 'c1', title: 'Run shell', kind: 'execute' },
        options: [
          { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
          { optionId: 'deny', kind: 'reject_once', name: 'Deny' }
        ]
      },
      { id: 1, signal: new AbortController().signal }
    )
    expect(reply).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    expect(promptHandle).not.toHaveBeenCalled()

    const requestHandler = acpStructuredRequestHandler(() => child, prompts)
    const context = { id: 2, signal: new AbortController().signal }
    await expect(
      requestHandler(ACP_FORM_ELICITATION_METHOD, { mode: 'form' }, context)
    ).resolves.toEqual({ action: 'cancel' })
    expect(() => requestHandler('custom/method', {}, context)).toThrow(REPLY_ONLY_REFUSAL)
    expect(promptHandle).not.toHaveBeenCalled()
  })
})

describe('initializeAcpStructuredSession with reply-only mode', () => {
  it('forces ask/default ACP mode even when the bot requests full-access permissionMode', async () => {
    const cwd = tempDir('agy-handshake-cwd-')
    const setConfigCalls: { id: string; value: unknown }[] = []
    const launchPermission = acpLaunchPermission(ANTIGRAVITY_LAUNCH_SPEC, false, 'ask')
    const connection = {
      exited: false,
      closed: false,
      stderrTail: () => '',
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
      start: async (
        _params: unknown,
        acceptSession?: (accepted: { kind: 'new'; sessionId: string; response: object }) => void
      ) => {
        const started = { kind: 'new' as const, sessionId: 'agy-session-1', response: {} }
        acceptSession?.(started)
        return started
      },
      setConfigOption: async (
        id: string,
        value: unknown,
        _meta: unknown,
        received?: (response: { configOptions: { id: string; currentValue: unknown }[] }) => void
      ) => {
        setConfigCalls.push({ id, value })
        received?.({ configOptions: [{ id, currentValue: value }] })
        return { configOptions: [{ id, currentValue: value }] }
      }
    }
    const lane = {
      apply: () => {},
      dispose: () => {},
      translator: {
        contextModels: () => [],
        finishLoad: () => {}
      }
    }
    const child = {
      ended: false,
      closeRequested: false,
      journalClosed: null,
      connection,
      spec: ANTIGRAVITY_LAUNCH_SPEC,
      ...launchPermission,
      readOnly: 'reply-only' as const,
      lane: null,
      turns: null
    }
    const opened = await initializeAcpStructuredSession(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stub covers handshake fields read on new session open.
      {
        acquire: {
          identity: { sessionId: 'tidy-1' },
          fence: 1,
          permissionMode: 'full-access'
        },
        signal: new AbortController().signal,
        deps: {},
        generation: 'gen-1',
        launch: {
          spec: ANTIGRAVITY_LAUNCH_SPEC,
          cwd,
          env: {},
          fullAccess: false,
          readOnly: 'reply-only',
          resume: null
        },
        connection,
        options: {
          adoptInitialize: () => {},
          adoptSession: () => {},
          modeConfigId: () => 'mode',
          adoptConfigOptions: () => {},
          observedCurrent: () => ({}),
          startListing: () => ({ models: [] })
        },
        prompts: { withdrawAll: () => {} },
        child,
        abandoned: () => false,
        lanes: { create: () => lane, clear: () => {}, finishLoad: () => null },
        onSettled: () => {},
        onSessionLost: () => {}
      } as unknown as Parameters<typeof initializeAcpStructuredSession>[0]
    )

    expect(opened.link?.handle.nativeId).toBe('agy-session-1')
    expect(setConfigCalls).toEqual([{ id: 'mode', value: 'default' }])
  })
})
