import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../../../shared/child-process/run-process'
import { buildSleepingAgentLaunchConfig } from '../../../../shared/sleeping-agent-launch-config'
import { buildAgentResumeStartupPlan } from '../../../../shared/tui-agent-resume-startup'
import type { IPtyProvider } from '../../../providers/types'
import { localProvider } from '../provider/registry'
import { noCodexResumeLaunch } from '../host-env/codex-resume'
import { assemblePtyIpcSpawnEnv } from './spawn-env'
import { executePtyIpcSpawn } from './spawn-execute'
import { preparePtyIpcSpawnPreflight } from './spawn-preflight'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcDeps } from './spawn-types'

vi.mock('../../../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))

const REFERENCE = 'doppler-ref://lets-tango/dev_ops/POSTHOG_READ_ONLY'
const SENTINEL = 'sentinel-plaintext-secret'

function createState(connectionId?: string) {
  const args = {
    cols: 100,
    rows: 30,
    env: { POSTHOG_READ_ONLY: REFERENCE },
    ...(connectionId ? { connectionId } : {})
  }
  const deps: PtySpawnIpcDeps = {
    getLocalPtyStartupPromise: () => undefined,
    adoptStablePane: async () => null,
    assertFolderWorkspacePtyPathUsable: () => {},
    resolvePtySpawnStartupCwd: () => undefined,
    localStartupCwdDirectoryExists: () => true,
    prepareCodexResumeHome: () => null,
    noCodexResumeLaunch,
    resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
    reconcileSharedRuntimeResumeHome: async (resumeHome) => resumeHome.codexHomePath,
    stripSequencedStartupResumeArgv: (env) => env,
    trustedTerminalHandleEnv: new Set<string>(),
    transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
    sendPtySpawnedToRenderer: vi.fn(),
    syncPtyBackgroundedDelivery: vi.fn()
  }
  return createPtyIpcSpawnState(deps, args)
}

function providerWith(spawn: IPtyProvider['spawn']): IPtyProvider {
  const provider = Object.create(localProvider) as IPtyProvider
  provider.spawn = spawn
  return provider
}

describe('IPC PTY secret references', () => {
  beforeEach(() => {
    vi.mocked(runProcess).mockReset()
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: `${SENTINEL}\n`,
      stderr: '',
      timedOut: false,
      outputTruncated: false
    })
  })

  it('rejects invalid candidates before account selection', async () => {
    const ctx = createState()
    ctx.args.env = { HOME: 'doppler-ref://lets-tango/dev_ops/HOME' }
    const accountSelection = vi.fn()
    ctx.deps.getSelectedCodexHomePath = accountSelection

    await expect(assemblePtyIpcSpawnEnv(ctx)).rejects.toMatchObject({
      code: 'invalid-reference',
      envKey: 'HOME'
    })
    expect(accountSelection).not.toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('rejects invalid candidates before Claude account preparation', async () => {
    const ctx = createState()
    ctx.args.command = 'claude'
    ctx.args.env = { HOME: 'doppler-ref://lets-tango/dev_ops/HOME' }
    const prepareClaudeAuth = vi.fn()
    ctx.deps.prepareClaudeAuth = prepareClaudeAuth

    await expect(preparePtyIpcSpawnPreflight(ctx)).rejects.toMatchObject({
      code: 'invalid-reference',
      envKey: 'HOME'
    })
    expect(prepareClaudeAuth).not.toHaveBeenCalled()
  })

  it('gives only a fresh local provider clone the resolved value', async () => {
    const ctx = createState()
    const authPatch = 'account-auth-patch'
    ctx.spawnOptions = {
      cols: 100,
      rows: 30,
      command: '/usr/local/bin/codex',
      env: { POSTHOG_READ_ONLY: REFERENCE, CLAUDE_CONFIG_DIR: authPatch }
    }
    const spawn = vi.fn(async () => ({ id: 'pty-1' }))
    ctx.provider = providerWith(spawn)

    await executePtyIpcSpawn(ctx)

    expect(spawn).toHaveBeenCalledWith({
      cols: 100,
      rows: 30,
      command: '/usr/local/bin/codex',
      env: { POSTHOG_READ_ONLY: SENTINEL, CLAUDE_CONFIG_DIR: authPatch }
    })
    expect(ctx.spawnOptions.env).toEqual({
      POSTHOG_READ_ONLY: REFERENCE,
      CLAUDE_CONFIG_DIR: authPatch
    })
    expect(ctx.spawnOptions.command).toBe('/usr/local/bin/codex')
  })

  it('rejects SSH before Doppler or provider spawn', async () => {
    const ctx = createState('connection-1')
    ctx.spawnOptions = { cols: 100, rows: 30, env: { POSTHOG_READ_ONLY: REFERENCE } }
    const spawn = vi.fn(async () => ({ id: 'pty-remote' }))
    ctx.provider = providerWith(spawn)

    await expect(executePtyIpcSpawn(ctx)).rejects.toMatchObject({ code: 'remote-target' })
    expect(runProcess).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('keeps settings, launch config, and resume state reference-only', () => {
    const launchConfig = buildSleepingAgentLaunchConfig({
      agentArgs: '',
      agentEnv: { POSTHOG_READ_ONLY: REFERENCE }
    })
    const resumed = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'thread-1' },
      cmdOverrides: { codex: 'codex' },
      platform: 'darwin',
      agentArgs: '',
      agentEnv: launchConfig.agentEnv
    })

    expect(launchConfig.agentEnv.POSTHOG_READ_ONLY).toBe(REFERENCE)
    expect(resumed?.launchConfig.agentEnv.POSTHOG_READ_ONLY).toBe(REFERENCE)
    expect(resumed?.env?.POSTHOG_READ_ONLY).toBe(REFERENCE)
  })
})
