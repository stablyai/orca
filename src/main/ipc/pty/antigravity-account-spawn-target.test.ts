import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAntigravityAccountForLaunch } from '../../antigravity/native-account-launch'
import { assemblePtyIpcSpawnEnv } from './ipc/spawn-env'
import { buildPtyIpcSpawnOptions } from './ipc/spawn-options'
import { createPtyIpcSpawnState } from './ipc/spawn-state'
import type { PtySpawnIpcDeps } from './ipc/spawn-types'
import { buildRuntimePtySpawnOptions } from './runtime/spawn-options'
import { createRuntimePtySpawnState } from './runtime/spawn-state'
import { configureLocalPtyProvider } from './provider/local-configure'
import { localProvider } from './provider/registry'
import { LocalPtyProvider } from '../../providers/local-pty-provider'
import type { PtyRuntimeControllerDeps } from './runtime/controller-deps'
import { prepareAntigravityPtySpawnTarget } from './antigravity-account-spawn-target'
import { getDefaultWslDistro } from '../../wsl'
import type * as WslModule from '../../wsl'
import { SessionNotFoundError } from '../../daemon/daemon-errors'
import { remainingAccountOperationMs } from '../../antigravity/native-account-operation'
import { executePtyIpcSpawn } from './ipc/spawn-execute'
import { executeRuntimePtySpawn } from './runtime/spawn-execute'

vi.mock('../../wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  getDefaultWslDistro: vi.fn(() => null)
}))

vi.mock('../../antigravity/native-account-launch', () => ({
  prepareAntigravityAccountForLaunch: vi.fn()
}))
vi.mock('./host-env/assembly', () => ({
  buildPtyHostEnv: (_id: string, env: Record<string, string>) => env
}))
vi.mock('./ipc/spawn-env-codex', () => ({ assemblePtyIpcSpawnCodexEnv: vi.fn() }))
const args = {
  cols: 80,
  rows: 24,
  launchAgent: 'antigravity',
  command: 'agy',
  env: {},
  envToDelete: ['HOME']
} as const
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.mocked(prepareAntigravityAccountForLaunch)
    .mockReset()
    .mockResolvedValue({ wslDistro: 'Ubuntu', authorityId: 'a'.repeat(64) })
})
describe('Antigravity WSL launch target at PTY entrypoints', () => {
  function runtimeAdmission() {
    const order: string[] = []
    let distro: string | null = null
    return {
      order,
      currentDistro: () => distro,
      runtime: {
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        beginPtyRegistration: vi.fn(() => order.push('registration')),
        preparePtyExecutionContext: vi.fn((_id: string, value: string | null) => {
          distro = value
          order.push(`context:${value}`)
          return true
        }),
        getPtyOutputSequence: vi.fn(() => {
          order.push('sequence')
          return 0
        }),
        assertPtyRegistrationAllowed: vi.fn()
      }
    }
  }
  function targetContext(): Parameters<typeof prepareAntigravityPtySpawnTarget>[0] {
    return {
      provider: { ...localProvider },
      spawnOptions: {
        cols: 80,
        rows: 24,
        cwd: 'C:\\repo',
        command: 'agy',
        launchAgent: 'antigravity' as const,
        shellOverride: 'wsl.exe'
      },
      preAdoptedStablePane: null,
      expectedWslDistro: null,
      terminalRuntimeOptions: {},
      codexSelectionTarget: { runtime: 'host' as const }
    }
  }

  it('reattaches a live raw daemon session without checking changed native accounts', async () => {
    const ctx = targetContext()
    ctx.spawnOptions.sessionId = 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\u\\repo@@abcd1234'
    const attached = { id: ctx.spawnOptions.sessionId, isReattach: true, wslDistro: 'Ubuntu' }
    ctx.provider.spawn = vi.fn().mockResolvedValue(attached)
    vi.mocked(prepareAntigravityAccountForLaunch).mockRejectedValue(
      new Error('native account changed')
    )
    const result = await prepareAntigravityPtySpawnTarget(ctx)
    expect(ctx.provider.spawn).toHaveBeenCalledOnce()
    expect(ctx.provider.spawn).toHaveBeenCalledWith(expect.objectContaining({ attachOnly: true }))
    expect(result).toEqual(attached)
    expect(prepareAntigravityAccountForLaunch).not.toHaveBeenCalled()
  })

  it('checks the sessionId WSL authority after an authoritative absent-session reply', async () => {
    const ctx = targetContext()
    ctx.spawnOptions.sessionId = 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\u\\repo@@abcd1234'
    ctx.provider.spawn = vi
      .fn()
      .mockRejectedValue(new SessionNotFoundError(ctx.spawnOptions.sessionId))
    await prepareAntigravityPtySpawnTarget(ctx)
    expect(ctx.provider.spawn).toHaveBeenCalledOnce()
    expect(prepareAntigravityAccountForLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ isWsl: true, wslDistro: 'Ubuntu' })
    )
    expect(ctx).not.toHaveProperty('antigravityAttachedPty')
  })

  it('rejects an attach reply that does not prove the requested process was reattached', async () => {
    const ctx = targetContext()
    ctx.spawnOptions.sessionId = 'requested-session'
    ctx.provider.spawn = vi.fn().mockResolvedValue({ id: 'another-session', isReattach: true })
    await expect(prepareAntigravityPtySpawnTarget(ctx)).rejects.toThrow('could not be verified')
    expect(prepareAntigravityAccountForLaunch).not.toHaveBeenCalled()
  })

  it('shares the remaining operation budget after a delayed absent-session reply', async () => {
    vi.useFakeTimers()
    const ctx = targetContext()
    ctx.spawnOptions.sessionId = 'missing-session'
    ctx.provider.spawn = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 8_000))
      throw new SessionNotFoundError('missing-session')
    })
    vi.mocked(prepareAntigravityAccountForLaunch).mockImplementation(async ({ operation }) => {
      if (!operation) {
        throw new Error('Missing operation budget')
      }
      expect(remainingAccountOperationMs(operation)).toBe(7_000)
      return new Promise<never>(() => {})
    })
    const pending = prepareAntigravityPtySpawnTarget(ctx)
    const rejected = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['connection lost', 'request timed out'])(
    'does not recreate an unverifiable daemon session after %s',
    async (message) => {
      const ctx = targetContext()
      ctx.spawnOptions.sessionId = 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\u\\repo@@abcd1234'
      ctx.provider.spawn = vi.fn().mockRejectedValue(new Error(message))
      await expect(prepareAntigravityPtySpawnTarget(ctx)).rejects.toThrow(message)
      expect(prepareAntigravityAccountForLaunch).not.toHaveBeenCalled()
    }
  )

  it('resolves an unknown default WSL distro without falling back to Host credentials', async () => {
    expect(getDefaultWslDistro()).toBeNull()
    const ctx = targetContext()
    await prepareAntigravityPtySpawnTarget(ctx)
    expect(prepareAntigravityAccountForLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ isWsl: true, wslDistro: undefined })
    )
    expect(ctx.expectedWslDistro).toBe('Ubuntu')
  })

  it('refuses to pin a daemon to a distro that contradicts its session identity', async () => {
    vi.mocked(prepareAntigravityAccountForLaunch).mockResolvedValueOnce({
      wslDistro: 'Debian',
      authorityId: 'a'.repeat(64)
    })
    const ctx = targetContext()
    const options = {
      ...ctx.spawnOptions,
      isNewSession: true,
      sessionId: 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\u\\repo@@abcd1234'
    }
    await expect(
      prepareAntigravityPtySpawnTarget({ ...ctx, spawnOptions: options })
    ).rejects.toThrow('does not match')
    expect(options).not.toHaveProperty('terminalWindowsWslDistro')
  })

  it('leaves client, live attach, local and degraded-local preparation to their execution owners', async () => {
    const ctx = targetContext()
    await prepareAntigravityPtySpawnTarget(ctx, 'ssh-owner')
    await prepareAntigravityPtySpawnTarget({ ...ctx, preAdoptedStablePane: { live: true } })
    await prepareAntigravityPtySpawnTarget({
      ...ctx,
      spawnOptions: { ...ctx.spawnOptions, attachOnly: true }
    })
    await prepareAntigravityPtySpawnTarget({ ...ctx, provider: localProvider })
    await prepareAntigravityPtySpawnTarget({
      ...ctx,
      provider: { ...ctx.provider, routesFreshSpawnsToLocalProvider: true }
    })
    expect(prepareAntigravityAccountForLaunch).not.toHaveBeenCalled()
  })

  it('passes the desktop target and pins the final provider options', async () => {
    const admission = runtimeAdmission()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies admission, context and delivery methods; workspace-dependent branches are disabled.
    const deps = {
      runtime: admission.runtime,
      transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
      syncPtyBackgroundedDelivery: vi.fn(),
      sendPtySpawnedToRenderer: vi.fn()
    } as unknown as PtySpawnIpcDeps
    const ctx = createPtyIpcSpawnState(deps, { ...args, envToDelete: [...args.envToDelete] })
    ctx.provider = { ...ctx.provider }
    ctx.provider.spawn = vi.fn(async () => {
      expect(admission.currentDistro()).toBe('Ubuntu')
      expect(admission.order).toContain('registration')
      expect(admission.order).toContain('sequence')
      return { id: 'desktop-daemon', wslDistro: 'Ubuntu' }
    })
    ctx.isDaemonHostSpawn = true
    ctx.codexSelectionTarget = { runtime: 'host' }
    ctx.expectedWslDistro = null
    ctx.cwd = 'C:\\repo'
    ctx.terminalRuntimeOptions.shellOverride = 'powershell.exe'
    ctx.effectiveShellOverride = 'powershell.exe'
    ctx.effectiveSessionId = 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\u\\repo@@abcd1234'
    ctx.isMintedSessionId = true
    ctx.launchCommand = 'agy'
    await assemblePtyIpcSpawnEnv(ctx)
    await buildPtyIpcSpawnOptions(ctx)
    await executePtyIpcSpawn(ctx)
    expect(prepareAntigravityAccountForLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        isWsl: true,
        wslDistro: 'Ubuntu',
        envToDelete: expect.arrayContaining(['HOME'])
      })
    )
    expect(ctx.spawnOptions.terminalWindowsWslDistro).toBe('Ubuntu')
    expect(ctx.expectedWslDistro).toBe('Ubuntu')
  })
  it('passes the headless target and pins the final provider options', async () => {
    const admission = runtimeAdmission()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies admission, context and delivery methods; workspace-dependent branches are disabled.
    const deps = {
      runtime: admission.runtime,
      sendPtySpawnedToRenderer: vi.fn(),
      trustedTerminalHandleEnv: new Set<string>(),
      sendPtyExitToRenderer: vi.fn()
    } as unknown as PtyRuntimeControllerDeps
    const ctx = createRuntimePtySpawnState(deps, { ...args, envToDelete: [...args.envToDelete] })
    ctx.provider = { ...ctx.provider }
    ctx.provider.spawn = vi.fn(async () => {
      expect(admission.currentDistro()).toBe('Ubuntu')
      expect(admission.order).toContain('registration')
      expect(admission.order).toContain('sequence')
      return { id: 'headless-daemon', wslDistro: 'Ubuntu' }
    })
    ctx.isDaemonHostSpawn = true
    ctx.codexSelectionTarget = { runtime: 'host' }
    ctx.expectedWslDistro = null
    ctx.cwd = 'C:\\repo'
    ctx.terminalRuntimeOptions.shellOverride = 'powershell.exe'
    ctx.sessionId = 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\u\\repo@@abcd1234'
    ctx.isNewDaemonSession = true
    ctx.launchCommand = 'agy'
    ctx.env = {}
    await buildRuntimePtySpawnOptions(ctx)
    await executeRuntimePtySpawn(ctx)
    expect(prepareAntigravityAccountForLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        isWsl: true,
        wslDistro: 'Ubuntu',
        envToDelete: expect.arrayContaining(['HOME'])
      })
    )
    expect(ctx.spawnOptions.terminalWindowsWslDistro).toBe('Ubuntu')
    expect(ctx.expectedWslDistro).toBe('Ubuntu')
  })
  it('defers configured local account verification until after final environment assembly', async () => {
    if (!(localProvider instanceof LocalPtyProvider)) {
      throw new Error('Expected local provider fixture')
    }
    const configure = vi.spyOn(localProvider, 'configure')
    configureLocalPtyProvider({ trustedTerminalHandleEnv: new Set() })
    const build = configure.mock.calls[0]?.[0].buildSpawnEnv
    if (!build) {
      throw new Error('Expected environment builder')
    }
    const pinWslDistro = vi.fn()
    const context = {
      isWsl: true,
      wslDistro: 'Ubuntu',
      command: 'agy',
      launchAgent: 'antigravity' as const,
      envToDelete: ['HOME'],
      pinWslDistro
    }
    await build('test-pty', {}, context)
    expect(prepareAntigravityAccountForLaunch).not.toHaveBeenCalled()
    expect(pinWslDistro).not.toHaveBeenCalled()
  })
})
