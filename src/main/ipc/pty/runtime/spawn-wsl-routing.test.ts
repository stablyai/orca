import { adoptMaterializedRuntimePtySpawn } from './spawn-early'
import { prepareWslDaemonReattachHooks } from '../../../wsl/wsl-daemon-reattach-hooks'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import * as Registry from '../provider/registry'
import { executeRuntimePtySpawn } from './spawn-execute'
import { ensureWslHookRelayForReattach } from '../../../agent-hooks/wsl-hook-relay-reattach'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { getDefaultSettings } from '../../../../shared/constants'
import { finishPtyShutdown } from '../provider/liveness'
import { localProvider } from '../provider/registry'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { buildRuntimePtySpawnOptions } from './spawn-options'
import { createRuntimePtySpawnState } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import {
  prepareWslDaemonSpawnRoute,
  type WslDaemonSpawnRoute
} from '../../../wsl/wsl-daemon-spawn-route'
import { prepareWslGuestTerminalSpawn } from '../../../wsl/wsl-guest-terminal-preparation'
import { buildPtyHostEnv } from '../host-env/assembly'
import { ensureCodexStateDbBackfillRecoveryStarted } from '../../../codex/codex-state-db-backfill-recovery'
import { toAppWslPtyId } from '../../../../shared/wsl-pty-id'
import { ptySizes } from '../delivery/visibility-state'

vi.mock('../../../wsl/wsl-daemon-reattach-hooks', () => ({
  prepareWslDaemonReattachHooks: vi.fn(async () => true)
}))
vi.mock('../../../agent-hooks/wsl-hook-relay-reattach', () => ({
  ensureWslHookRelayForReattach: vi.fn()
}))
vi.mock('../../../wsl/wsl-daemon-spawn-route', () => ({ prepareWslDaemonSpawnRoute: vi.fn() }))
vi.mock('../../../wsl/wsl-guest-terminal-preparation', () => ({
  prepareWslGuestTerminalSpawn: vi.fn()
}))
vi.mock('../host-env/assembly', () => ({
  buildPtyHostEnv: vi.fn(() => {
    throw new Error('host env must not run for guest')
  })
}))
vi.mock('../../../codex/codex-state-db-backfill-recovery', () => ({
  ensureCodexStateDbBackfillRecoveryStarted: vi.fn()
}))
const HOST_DEFAULT_SHELL = 'wsl.exe'
const hostPlatform = process.platform
function makeDeps(): PtyRuntimeControllerDeps {
  const noCodexResumeLaunch: PtyRuntimeControllerDeps['noCodexResumeLaunch'] = (command) => ({
    codexResumeHome: null,
    command,
    notifyResumeUnavailable: false,
    droppedResumeArgv: false,
    providerSession: null
  })
  return {
    store: undefined,
    getSettings: () => ({
      ...getDefaultSettings('/tmp'),
      terminalWindowsShell: HOST_DEFAULT_SHELL
    }),
    adoptStablePane: async () => null,
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    prepareCodexResumeHome: () => null,
    resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
    noCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome: async (resumeHome) => resumeHome.codexHomePath,
    stripSequencedStartupResumeArgv: (env) => env,
    assertFolderWorkspacePtyPathUsable: () => undefined,
    resolvePtySpawnStartupCwd: (_worktreeId, cwd) => cwd,
    requestSerializedBuffer: async () => null,
    shutdownProviderAndDetectExit: async () => false,
    rememberSyntheticKillExit: () => {},
    rememberRetiredRejectedPty: () => {},
    sendPtyExitToRenderer: () => {},
    sendPtySpawnedToRenderer: () => {},
    finishPtyShutdown,
    trustedTerminalHandleEnv: new Set(),
    retiredRejectedPtyIds: new Map(),
    reversibleStopOwnersByPtyId: new Map(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `operations.ts` (write/clearBuffer) reads `mainWindow`; the spawn preflight and option build never touch it, and a real BrowserWindow cannot exist in vitest.
    mainWindow: {} as BrowserWindow
  }
}

const endpoint = {
  distro: 'Ubuntu',
  distributionId: 'registration',
  userName: 'alice',
  userId: '1000',
  home: '/home/alice',
  runtime: '/bun',
  entry: '/daemon',
  envBinary: '/usr/bin/env',
  socket: '/socket',
  tokenPath: '/token',
  serverBuildId: 'build'
}
const owner = { distro: 'Ubuntu', relayBuildId: 'owner' }
function route(fresh = true): WslDaemonSpawnRoute {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These preflight tests never invoke provider operations; localProvider supplies the IPtyProvider surface consumed here.
  const provider = localProvider as WslDaemonSpawnRoute['connection']['provider']
  return {
    fresh,
    connection: { owner, endpoint, provider },
    prepared: { owner, endpoint },
    execution: endpoint
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.mocked(prepareWslDaemonSpawnRoute).mockResolvedValue(route())
  vi.mocked(prepareWslGuestTerminalSpawn).mockImplementation(async (_prepared, options) => ({
    ...options,
    env: { ...options.env, GUEST_PREPARED: '1' }
  }))
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  ptySizes.clear()
  vi.restoreAllMocks()
})

describe('runtime guest daemon routing', () => {
  it('captures guest identity before Claude/Codex preparation and builds guest env once', async () => {
    const deps = makeDeps()
    const order: string[] = []
    vi.mocked(prepareWslDaemonSpawnRoute).mockImplementation(async () => {
      order.push('owner')
      return route()
    })
    deps.prepareClaudeAuth = vi.fn(async () => {
      order.push('claude')
      return {
        envPatch: {},
        stripAuthEnv: false,
        configDir: '/home/alice/.claude',
        provenance: 'captured'
      }
    })
    deps.getSelectedCodexHomePath = vi.fn(async () => {
      order.push('codex')
      return '/home/alice/.codex'
    })
    deps.prepareCodexResumeHome = vi.fn(() => null)
    deps.assertFolderWorkspacePtyPathUsable = vi.fn(() => {
      throw new Error('host path probe')
    })
    const ctx = createRuntimePtySpawnState(deps, {
      cols: 80,
      rows: 24,
      command: 'claude',
      initiallyHidden: true
    })
    await prepareRuntimePtySpawn(ctx)
    expect(order).toEqual(['owner', 'claude', 'codex'])
    expect(deps.prepareClaudeAuth).toHaveBeenCalledWith(
      { runtime: 'wsl', wslDistro: 'Ubuntu' },
      endpoint
    )
    expect(deps.prepareCodexResumeHome).toHaveBeenCalledWith(
      expect.objectContaining({ wslExecution: endpoint })
    )
    expect(deps.getSelectedCodexHomePath).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ wslExecution: endpoint })
    )
    const raw = ctx.sessionId!
    expect(raw).not.toMatch(/^wsl:/)
    expect(ctx.effectiveSessionAppId).toBe(toAppWslPtyId(owner, raw))
    await buildRuntimePtySpawnOptions(ctx)
    expect(ctx.spawnOptions.sessionId).toBe(raw)
    expect(ctx.spawnOptions.isNewSession).toBe(true)
    expect(ptySizes.get(ctx.effectiveSessionAppId!)).toEqual({ cols: 80, rows: 24 })
    expect(prepareWslGuestTerminalSpawn).toHaveBeenCalledOnce()
    expect(buildPtyHostEnv).not.toHaveBeenCalled()
    expect(ensureCodexStateDbBackfillRecoveryStarted).not.toHaveBeenCalled()
    ctx.finishTerminalInstall()
  })

  it('retains encoded attach identity and skips account prep for a live guest owner', async () => {
    vi.mocked(prepareWslDaemonSpawnRoute).mockResolvedValue(route(false))
    const deps = makeDeps()
    deps.getSelectedCodexHomePath = vi.fn()
    deps.prepareClaudeAuth = vi.fn()
    deps.prepareCodexResumeHome = vi.fn(() => null)
    const id = toAppWslPtyId(owner, 'pty2:kept:1')
    const ctx = createRuntimePtySpawnState(deps, {
      cols: 80,
      rows: 24,
      sessionId: id,
      command: 'claude'
    })
    await prepareRuntimePtySpawn(ctx)
    await buildRuntimePtySpawnOptions(ctx)
    expect(ctx.spawnOptions.sessionId).toBe(id)
    expect(ctx.spawnOptions.isNewSession).toBeUndefined()
    expect(ctx.spawnOptions.attachOnly).toBe(true)
    expect(prepareWslGuestTerminalSpawn).not.toHaveBeenCalled()
    expect(buildPtyHostEnv).not.toHaveBeenCalled()
    expect(ctx.effectiveSessionAppId).toBe(id)
    expect(deps.prepareClaudeAuth).not.toHaveBeenCalled()
    expect(deps.getSelectedCodexHomePath).not.toHaveBeenCalled()
    expect(deps.prepareCodexResumeHome).not.toHaveBeenCalled()
    ctx.finishTerminalInstall()
  })

  it('passes explicit fresh raw identities to route selection without changing their daemon ID', async () => {
    const deps = makeDeps()
    const ctx = createRuntimePtySpawnState(deps, {
      cols: 80,
      rows: 24,
      sessionId: 'pty2:allocated:1',
      isNewSession: true
    })
    await prepareRuntimePtySpawn(ctx)
    expect(prepareWslDaemonSpawnRoute).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty2:allocated:1', isNewSession: true })
    )
    expect(ctx.sessionId).toBe('pty2:allocated:1')
    expect(ctx.effectiveSessionAppId).toBe(toAppWslPtyId(owner, 'pty2:allocated:1'))
  })
})

it('marks and registers the encoded guest ID before provider output can begin', async () => {
  const deps = makeDeps()
  const order: string[] = []
  deps.transitionSpawnHiddenRendererPtyDeliveryState = vi.fn((id) => {
    order.push(`hidden:${id}`)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: With no pane/workspace metadata, execute only invokes these optional runtime hooks.
  deps.runtime = {
    beginPtyRegistration: (id: string) => {
      order.push(`register:${id}`)
    },
    preparePtyExecutionContext: () => false,
    assertPtyRegistrationAllowed: () => {}
  } as unknown as OrcaRuntimeService
  const ctx = createRuntimePtySpawnState(deps, { cols: 80, rows: 24, initiallyHidden: true })
  await prepareRuntimePtySpawn(ctx)
  await buildRuntimePtySpawnOptions(ctx)
  const appId = ctx.effectiveSessionAppId!
  vi.spyOn(Registry, 'tryGetProviderForAgentSessionOwner').mockReturnValue(ctx.provider)
  vi.spyOn(ctx.provider, 'spawn').mockImplementation(async (options) => {
    expect(options.sessionId).toBe(ctx.sessionId)
    expect(order.slice(0, 2)).toEqual([`hidden:${appId}`, `register:${appId}`])
    order.push('output-can-start')
    return { id: appId, wslDistro: 'Ubuntu' }
  })
  try {
    await executeRuntimePtySpawn(ctx)
    expect(ctx.result.id).toBe(appId)
    expect(ensureWslHookRelayForReattach).not.toHaveBeenCalled()
  } finally {
    ctx.finishTerminalInstall()
  }
})

it('prepares captured-user hooks on runtime guest reattach', async () => {
  const deps = makeDeps()
  vi.mocked(prepareWslDaemonSpawnRoute).mockResolvedValue(route(false))
  const id = toAppWslPtyId(owner, 'retained')
  const ctx = createRuntimePtySpawnState(deps, { cols: 80, rows: 24, sessionId: id })
  await prepareRuntimePtySpawn(ctx)
  await buildRuntimePtySpawnOptions(ctx)
  vi.spyOn(Registry, 'tryGetProviderForAgentSessionOwner').mockReturnValue(ctx.provider)
  vi.spyOn(ctx.provider, 'spawn').mockResolvedValue({ id, isReattach: true, wslDistro: 'Ubuntu' })
  try {
    await executeRuntimePtySpawn(ctx)
    expect(prepareWslDaemonReattachHooks).toHaveBeenCalledWith({
      result: expect.objectContaining({ id, isReattach: true }),
      sessions: deps.options?.wslDaemonSessions,
      hooksEnabled: true
    })
    expect(ensureWslHookRelayForReattach).not.toHaveBeenCalled()
  } finally {
    ctx.finishTerminalInstall()
  }
})

it('prepares captured-user hooks for an already-materialized runtime guest pane', async () => {
  const deps = makeDeps()
  const id = toAppWslPtyId(owner, 'materialized')
  const ctx = createRuntimePtySpawnState(deps, {
    cols: 80,
    rows: 24,
    adoptedStablePane: {
      materialized: true,
      owner: { ptyId: id, handle: 'handle', tabId: 'tab', leafId: 'leaf' },
      result: { id, isReattach: true, wslDistro: 'Ubuntu' }
    }
  })
  await adoptMaterializedRuntimePtySpawn(ctx)
  expect(prepareWslDaemonReattachHooks).toHaveBeenCalledWith({
    result: expect.objectContaining({ id, isReattach: true }),
    sessions: deps.options?.wslDaemonSessions,
    hooksEnabled: true
  })
})

it('prepares same-ID runtime cold restore with captured guest account context', async () => {
  vi.mocked(prepareWslDaemonSpawnRoute).mockResolvedValue({ ...route(false), coldRestore: true })
  const deps = makeDeps()
  deps.getSelectedCodexHomePath = vi.fn(async () => null)
  deps.prepareClaudeAuth = vi.fn(async () => ({
    configDir: '/home/alice/.claude',
    envPatch: {},
    stripAuthEnv: false,
    provenance: 'test'
  }))
  deps.prepareCodexResumeHome = vi.fn(() => null)
  const id = toAppWslPtyId(owner, 'pty2:kept:1')
  const ctx = createRuntimePtySpawnState(deps, {
    cols: 80,
    rows: 24,
    sessionId: id,
    command: 'claude --resume current'
  })
  await prepareRuntimePtySpawn(ctx)
  await buildRuntimePtySpawnOptions(ctx)
  expect(ctx.spawnOptions).toMatchObject({
    sessionId: id,
    isNewSession: false,
    attachOnly: false,
    command: 'claude --resume current'
  })
  expect(deps.prepareClaudeAuth).toHaveBeenCalledWith(expect.anything(), endpoint)
  expect(deps.prepareCodexResumeHome).toHaveBeenCalled()
  expect(prepareWslGuestTerminalSpawn).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ sessionId: id }),
    expect.anything(),
    undefined,
    'confirmed-exited'
  )
  ctx.finishTerminalInstall()
})
