import * as ProviderStateCleanup from '../provider/state-cleanup'
import { ensureCodexStateDbBackfillRecoveryStarted } from '../../../codex/codex-state-db-backfill-recovery'
import type * as GuestSpawnOptions from '../../../wsl/wsl-guest-spawn-options'
import type * as GuestTerminalPreparation from '../../../wsl/wsl-guest-terminal-preparation'
import { prepareWslDaemonSpawnRoute } from '../../../wsl/wsl-daemon-spawn-route'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { toAppWslPtyId } from '../../../../shared/wsl-pty-id'
import { DaemonPtyAdapter } from '../../../daemon/daemon-pty-adapter'
import { WslDaemonPtyProvider } from '../../../wsl/wsl-daemon-pty-provider'
import { WslDaemonSessions } from '../../../wsl/wsl-daemon-sessions'
import { prepareWslGuestTerminalSpawn } from '../../../wsl/wsl-guest-terminal-preparation'
import { buildPtyHostEnv } from '../host-env/assembly'
import {
  noCodexResumeLaunch,
  resolveCodexResumeLaunch,
  stripSequencedStartupResumeArgv
} from '../host-env/codex-resume'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { preparePtyIpcSpawnPreflight } from './spawn-preflight'
import { assemblePtyIpcSpawnEnv } from './spawn-env'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { executePtyIpcSpawn } from './spawn-execute'
import { ptySizes } from '../delivery/visibility-state'
import { wslHookRelayManager } from '../../../agent-hooks/wsl-hook-relay-manager'

vi.mock('../../../codex/codex-state-db-backfill-recovery', () => ({
  ensureCodexStateDbBackfillRecoveryStarted: vi.fn()
}))
vi.mock('../host-env/assembly', () => ({ buildPtyHostEnv: vi.fn((_id, env) => env) }))
vi.mock('../../../wsl/wsl-guest-spawn-options', async (original) => ({
  ...(await original<typeof GuestSpawnOptions>()),
  prepareWslGuestSpawnOptions: vi.fn(async (_owner, options) => options)
}))
vi.mock('../../../agent-hooks/wsl-hook-relay-manager', () => ({
  wslHookRelayManager: {
    ensureForDistro: vi.fn(async () => {}),
    getGuestEndpointFilePath: vi.fn(() => '/home/alice/.orca-wsl/agent-hooks/endpoint')
  }
}))
vi.mock('../../../wsl', () => ({ getDefaultWslDistro: () => 'Ubuntu', parseWslPath: () => null }))
vi.mock('../../../wsl/wsl-guest-terminal-preparation', async (original) => {
  const actual = await original<typeof GuestTerminalPreparation>()
  return { ...actual, prepareWslGuestTerminalSpawn: vi.fn(actual.prepareWslGuestTerminalSpawn) }
})
const platform = process.platform
const owner = { distro: 'Ubuntu', relayBuildId: 'daemon+artifact+alice' }
const endpoint = {
  distro: 'Ubuntu',
  distributionId: 'registration',
  userName: 'alice',
  userId: '1000',
  home: '/home/alice',
  runtime: '/bin/bun',
  entry: '/daemon.js',
  envBinary: '/usr/bin/env',
  socket: '/socket',
  tokenPath: '/token',
  serverBuildId: 'artifact'
}
const execution = { distro: 'Ubuntu', userName: 'alice', userId: '1000', home: '/home/alice' }
const prepared = { owner, endpoint, entry: '/daemon.js', path: '/bin', artifactId: 'artifact' }

function fixture(args: Partial<PtySpawnIpcArgs> = {}) {
  const adapter = new DaemonPtyAdapter({
    guest: {
      distro: 'Ubuntu',
      defaultShell: '/bin/bash',
      defaultCwd: '/home/alice',
      profiles: [],
      transport: {
        readToken: () => 'unused',
        connect: async () => {
          throw new Error('unexpected connection')
        }
      }
    }
  })
  const provider = new WslDaemonPtyProvider(owner, adapter)
  vi.spyOn(provider, 'probePtyLiveness').mockResolvedValue(true)
  const connection = { owner, endpoint, provider }
  const sessions = new WslDaemonSessions({
    profileScope: '/profile',
    historyRoot: '/history',
    store: {
      getWslDaemonRecovery: () => null,
      upsertWslDaemonRecovery: async () => {}
    }
  })
  const fresh = vi
    .spyOn(sessions, 'prepareFresh')
    .mockResolvedValue({ prepared, execution, connection })
  const reconnect = vi.spyOn(sessions, 'reconnect').mockResolvedValue(connection)
  const auth = vi.fn(async () => ({
    envPatch: {},
    stripAuthEnv: false,
    configDir: '/home/alice/.claude',
    provenance: 'captured-user'
  }))
  const selected = vi.fn<NonNullable<PtySpawnIpcDeps['getSelectedCodexHomePath']>>(async () => null)
  const prepareResume = vi.fn(() => null)
  const deps: PtySpawnIpcDeps = {
    options: { wslDaemonSessions: sessions },
    getSettings: () => ({ ...getDefaultSettings('/profile'), terminalWindowsDefaultShell: 'wsl' }),
    prepareClaudeAuth: auth,
    getSelectedCodexHomePath: selected,
    getLocalPtyStartupPromise: () => undefined,
    adoptStablePane: async () => null,
    assertFolderWorkspacePtyPathUsable: () => {},
    resolvePtySpawnStartupCwd: (_id, cwd) => cwd,
    localStartupCwdDirectoryExists: () => true,
    prepareCodexResumeHome: prepareResume,
    noCodexResumeLaunch,
    resolveCodexResumeLaunch,
    stripSequencedStartupResumeArgv,
    reconcileSharedRuntimeResumeHome: async (_home, resolve) => (await resolve()) ?? '',
    transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
    trustedTerminalHandleEnv: new Set(),
    sendPtySpawnedToRenderer: () => {},
    syncPtyBackgroundedDelivery: () => {},
    stopReplacedPty: async () => {}
  }
  const ctx = createPtyIpcSpawnState(deps, {
    cols: 91,
    rows: 31,
    shellOverride: 'wsl.exe',
    cwd: '/home/alice',
    initiallyHidden: true,
    ...args
  })
  const spawn = vi.spyOn(provider, 'spawn').mockImplementation(async (options) => ({
    id: options.sessionId?.startsWith('wsl:')
      ? options.sessionId
      : toAppWslPtyId(owner, options.sessionId!),
    wslDistro: 'Ubuntu',
    ...(options.attachOnly ? { isReattach: true } : {})
  }))
  return { ctx, deps, provider, fresh, reconnect, auth, selected, prepareResume, spawn, adapter }
}
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.clearAllMocks()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  ptySizes.clear()
  vi.restoreAllMocks()
})

it('captures the owner before auth and builds guest host-env exactly once with raw ID', async () => {
  const { ctx, deps, fresh, auth, selected, prepareResume, spawn, adapter } = fixture({
    command: 'claude'
  })
  await preparePtyIpcSpawnPreflight(ctx)
  expect(fresh).toHaveBeenCalledWith('Ubuntu', undefined)
  expect(auth).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' }, execution)
  expect(fresh.mock.invocationCallOrder[0]).toBeLessThan(auth.mock.invocationCallOrder[0])
  expect(ctx.effectiveSessionId).not.toMatch(/^wsl:/)
  expect(ctx.effectiveSessionAppId).toBe(toAppWslPtyId(owner, ctx.effectiveSessionId!))
  await assemblePtyIpcSpawnEnv(ctx)
  expect(selected).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ wslExecution: execution })
  )
  expect(prepareResume).toHaveBeenCalledWith(expect.objectContaining({ wslExecution: execution }))
  expect(buildPtyHostEnv).not.toHaveBeenCalled()
  await buildPtyIpcSpawnOptions(ctx)
  expect(buildPtyHostEnv).toHaveBeenCalledOnce()
  expect(buildPtyHostEnv).toHaveBeenCalledWith(
    ctx.effectiveSessionId,
    expect.anything(),
    expect.objectContaining({ isWsl: true, wslUser: 'alice' })
  )
  expect(prepareWslGuestTerminalSpawn).toHaveBeenCalledOnce()
  expect(ptySizes.get(ctx.effectiveSessionAppId!)).toEqual({ cols: 91, rows: 31 })
  expect(ptySizes.has(ctx.effectiveSessionId!)).toBe(false)
  expect(deps.transitionSpawnHiddenRendererPtyDeliveryState).toHaveBeenLastCalledWith(
    ctx.effectiveSessionAppId,
    true
  )
  await executePtyIpcSpawn(ctx)
  expect(spawn).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: ctx.effectiveSessionId, isNewSession: true })
  )
  expect(ctx.result.id).toBe(ctx.effectiveSessionAppId)
  adapter.dispose()
})

it('reattaches the persisted encoded owner without auth, host-env or default-user hooks', async () => {
  const id = toAppWslPtyId(owner, 'guest-pty')
  const { ctx, fresh, reconnect, auth, selected, spawn, adapter } = fixture({
    sessionId: id,
    command: 'claude'
  })
  await preparePtyIpcSpawnPreflight(ctx)
  await assemblePtyIpcSpawnEnv(ctx)
  await buildPtyIpcSpawnOptions(ctx)
  expect(fresh).not.toHaveBeenCalled()
  expect(reconnect).toHaveBeenCalledWith(expect.objectContaining(owner), undefined)
  expect(auth).not.toHaveBeenCalled()
  expect(selected).not.toHaveBeenCalled()
  expect(buildPtyHostEnv).not.toHaveBeenCalled()
  await executePtyIpcSpawn(ctx)
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id, attachOnly: true }))
  expect(wslHookRelayManager.ensureForDistro).toHaveBeenCalledWith(
    'Ubuntu',
    undefined,
    undefined,
    'alice'
  )
  adapter.dispose()
})

it('keeps legacy raw session IDs on their original provider', async () => {
  const { ctx, provider, fresh, reconnect, adapter } = fixture({ sessionId: 'legacy-session' })
  await preparePtyIpcSpawnPreflight(ctx)
  expect(ctx.wslGuest).toBeNull()
  expect(ctx.provider).not.toBe(provider)
  expect(fresh).not.toHaveBeenCalled()
  expect(reconnect).not.toHaveBeenCalled()
  adapter.dispose()
})

it('limits fresh routing to Windows WSL and distinguishes explicitly fresh runtime IDs', async () => {
  const { fresh, reconnect, adapter } = fixture()
  const sessions = { prepareFresh: fresh, reconnect }
  await expect(
    prepareWslDaemonSpawnRoute({ sessions, distro: 'Ubuntu', platform: 'linux' })
  ).resolves.toBeNull()
  await expect(
    prepareWslDaemonSpawnRoute({
      sessions,
      distro: 'Ubuntu',
      connectionId: 'ssh',
      platform: 'win32'
    })
  ).resolves.toBeNull()
  await expect(
    prepareWslDaemonSpawnRoute({
      sessions,
      distro: 'Ubuntu',
      sessionId: 'raw-existing',
      platform: 'win32'
    })
  ).resolves.toBeNull()
  expect(fresh).not.toHaveBeenCalled()
  await expect(
    prepareWslDaemonSpawnRoute({
      sessions,
      distro: 'Ubuntu',
      sessionId: 'raw-fresh',
      isNewSession: true,
      platform: 'win32'
    })
  ).resolves.toMatchObject({ fresh: true })
  expect(fresh).toHaveBeenCalledOnce()
  adapter.dispose()
})

it('fails closed when an encoded owner has no profile service', async () => {
  await expect(
    prepareWslDaemonSpawnRoute({
      sessionId: toAppWslPtyId(owner, 'existing'),
      platform: 'win32'
    })
  ).rejects.toThrow('unavailable')
})

it('passes captured user to Codex selection and avoids desktop backfill probes of guest paths', async () => {
  const { ctx, selected, prepareResume, adapter } = fixture({
    command: 'codex',
    launchAgent: 'codex'
  })
  selected.mockResolvedValue('/home/alice/.codex')
  await preparePtyIpcSpawnPreflight(ctx)
  await assemblePtyIpcSpawnEnv(ctx)
  expect(selected).toHaveBeenCalledWith(
    { runtime: 'wsl', wslDistro: 'Ubuntu' },
    undefined,
    expect.objectContaining({ wslExecution: execution, launchAgent: 'codex' })
  )
  expect(prepareResume).toHaveBeenCalledWith(expect.objectContaining({ wslExecution: execution }))
  expect(ensureCodexStateDbBackfillRecoveryStarted).not.toHaveBeenCalled()
  expect(buildPtyHostEnv).not.toHaveBeenCalled()
  adapter.dispose()
})

it('cold restores the same absent guest ID with captured-user auth and guest environment preparation', async () => {
  const id = toAppWslPtyId(owner, 'guest-pty')
  const { ctx, provider, fresh, auth, selected, spawn, adapter } = fixture({
    sessionId: id,
    command: 'claude --resume current'
  })
  vi.mocked(provider.probePtyLiveness).mockResolvedValue(false)
  await preparePtyIpcSpawnPreflight(ctx)
  await assemblePtyIpcSpawnEnv(ctx)
  await buildPtyIpcSpawnOptions(ctx)
  expect(ctx.wslGuest).toMatchObject({ fresh: false, coldRestore: true })
  expect(fresh).not.toHaveBeenCalled()
  expect(auth).toHaveBeenCalledWith(expect.anything(), execution)
  expect(selected).toHaveBeenCalled()
  expect(prepareWslGuestTerminalSpawn).toHaveBeenCalledWith(
    expect.objectContaining({ owner, endpoint }),
    expect.objectContaining({ sessionId: id, isNewSession: false, attachOnly: false }),
    expect.anything(),
    undefined,
    'confirmed-exited'
  )
  await executePtyIpcSpawn(ctx)
  expect(spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: id,
      isNewSession: false,
      attachOnly: false,
      command: 'claude --resume current'
    })
  )
  adapter.dispose()
})
it('refuses retained guest restore when the admitted owner cannot prove session absence', async () => {
  const { ctx, provider, fresh, auth, spawn, adapter } = fixture({
    sessionId: toAppWslPtyId(owner, 'guest-pty')
  })
  vi.mocked(provider.probePtyLiveness).mockResolvedValue(null)
  await expect(preparePtyIpcSpawnPreflight(ctx)).rejects.toThrow('unverifiable')
  expect(fresh).not.toHaveBeenCalled()
  expect(auth).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
  adapter.dispose()
})

it.each([false, true])(
  'preserves retained provider state on preparation failure (fresh=%s)',
  async (freshSession) => {
    const id = toAppWslPtyId(owner, 'retained-after-failure')
    const { ctx, provider, spawn, adapter } = fixture(freshSession ? {} : { sessionId: id })
    vi.mocked(provider.probePtyLiveness).mockResolvedValue(false)
    const clear = vi.spyOn(ProviderStateCleanup, 'clearProviderPtyState')
    try {
      await preparePtyIpcSpawnPreflight(ctx)
      await assemblePtyIpcSpawnEnv(ctx)
      vi.mocked(prepareWslGuestTerminalSpawn).mockRejectedValueOnce(
        new Error('guest preparation failed')
      )
      await expect(buildPtyIpcSpawnOptions(ctx)).rejects.toThrow('guest preparation failed')
      expect(spawn).not.toHaveBeenCalled()
      if (freshSession) {
        expect(clear).toHaveBeenCalledExactlyOnceWith(ctx.effectiveSessionId)
      } else {
        expect(clear).not.toHaveBeenCalled()
        expect(ctx.effectiveSessionAppId).toBe(id)
        expect(ctx.isMintedSessionId).toBe(false)
      }
    } finally {
      adapter.dispose()
    }
  }
)
