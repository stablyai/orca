import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orca-missing-provider-test', isPackaged: false }
}))
vi.mock('node-pty', () => ({ spawn: vi.fn(), default: { spawn: vi.fn() } }))

import type { IPtyProvider } from '../../../providers/types'
import { setSshProviderMissRecovery } from '../../../providers/ssh-provider-miss-recovery'
import { sshProviders } from './registry'
import { preparePtyIpcSpawnPreflight } from '../ipc/spawn-preflight'
import { createPtyIpcSpawnState } from '../ipc/spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from '../ipc/spawn-types'
import { prepareRuntimePtySpawn } from '../runtime/spawn-preflight'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from '../runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from '../runtime/controller-deps'
import { adoptStablePane } from '../pane/adopt-stable'
import { noCodexResumeLaunch } from '../host-env/codex-resume'

const TARGET = 'runtime-ssh-orca-restarted'

/**
 * Behavioural pin for the spawn-time re-attach. Each spawn path is executed against a
 * registry that has no provider for the target; the installed recovery registers one when
 * it runs. If a path resolves the provider before (or without) awaiting the recovery, it
 * throws the provider miss and the test fails. A source-text ordering check could not
 * tell a gated recovery (`args.sessionId ? recover : undefined`) from an unconditional one.
 */
function installRegisteringRecovery(): ReturnType<typeof vi.fn> {
  const provider = { spawn: vi.fn(async () => ({ id: `ssh:${TARGET}@@pty-1` })) }
  const recovery = vi.fn((connectionId: string) => {
    if (connectionId !== TARGET) {
      return undefined
    }
    return Promise.resolve().then(() => {
      sshProviders.set(TARGET, provider as unknown as IPtyProvider)
    })
  })
  setSshProviderMissRecovery(recovery)
  return recovery
}

function rendererDeps(): PtySpawnIpcDeps {
  return {
    getLocalPtyStartupPromise: () => undefined,
    adoptStablePane: vi.fn(async () => null),
    assertFolderWorkspacePtyPathUsable: () => undefined,
    resolvePtySpawnStartupCwd: (_worktreeId, cwd) => cwd,
    localStartupCwdDirectoryExists: () => true,
    prepareCodexResumeHome: () => null,
    noCodexResumeLaunch,
    resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
    reconcileSharedRuntimeResumeHome: async () => '',
    stripSequencedStartupResumeArgv: (env) => env,
    transitionSpawnHiddenRendererPtyDeliveryState: vi.fn()
  } as unknown as PtySpawnIpcDeps
}

function runtimeDeps(): PtyRuntimeControllerDeps {
  return {
    adoptStablePane: vi.fn(async () => null),
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    prepareCodexResumeHome: () => null,
    resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
    noCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome: async () => '',
    stripSequencedStartupResumeArgv: (env) => env,
    assertFolderWorkspacePtyPathUsable: () => undefined,
    resolvePtySpawnStartupCwd: (_worktreeId, cwd) => cwd
  } as unknown as PtyRuntimeControllerDeps
}

beforeEach(() => {
  sshProviders.delete(TARGET)
})

afterEach(() => {
  setSshProviderMissRecovery(null)
  sshProviders.delete(TARGET)
})

describe('renderer pty:spawn preflight', () => {
  it.each([
    ['a fresh terminal (no sessionId)', {}],
    ['a reattach (sessionId supplied)', { sessionId: `ssh:${TARGET}@@pty-1` }]
  ])('re-attaches the relay before resolving the provider for %s', async (_label, extra) => {
    const recovery = installRegisteringRecovery()
    const args = {
      cols: 80,
      rows: 24,
      connectionId: TARGET,
      cwd: '/w',
      ...extra
    } as PtySpawnIpcArgs
    const ctx = createPtyIpcSpawnState(rendererDeps(), args)

    await preparePtyIpcSpawnPreflight(ctx)

    expect(recovery).toHaveBeenCalledWith(TARGET)
    expect(ctx.provider).toBe(sshProviders.get(TARGET))
  })

  it('still fails on the miss when the recovery declines the connection', async () => {
    setSshProviderMissRecovery(() => undefined)
    const args = { cols: 80, rows: 24, connectionId: TARGET, cwd: '/w' } as PtySpawnIpcArgs
    await expect(
      preparePtyIpcSpawnPreflight(createPtyIpcSpawnState(rendererDeps(), args))
    ).rejects.toThrow(/^No PTY provider for connection/)
  })
})

describe('runtime controller spawn preflight', () => {
  it.each([
    ['a fresh terminal', {}],
    ['a caller-supplied session', { sessionId: `ssh:${TARGET}@@pty-1` }]
  ])('re-attaches the relay before resolving the provider for %s', async (_label, extra) => {
    const recovery = installRegisteringRecovery()
    const args = {
      cols: 80,
      rows: 24,
      connectionId: TARGET,
      cwd: '/w',
      ...extra
    } as RuntimePtySpawnArgs
    const ctx = createRuntimePtySpawnState(runtimeDeps(), args)

    await prepareRuntimePtySpawn(ctx)

    expect(recovery).toHaveBeenCalledWith(TARGET)
    expect(ctx.provider).toBe(sshProviders.get(TARGET))
  })
})

describe('stable-pane adoption', () => {
  it.each([
    ['when it owns the pane spawn reservation', { ownsPaneSpawnReservation: true as const }],
    ['when it does not own the reservation', {}]
  ])('re-attaches the relay before resolving the provider %s', async (_label, extra) => {
    const recovery = installRegisteringRecovery()
    // No persisted owner → adoption returns null, but only after the recovery ran; without a
    // provider the pre-recovery path would have thrown the miss on the way to the lookup.
    const adopted = await adoptStablePane(undefined, undefined, {
      cols: 80,
      rows: 24,
      cwd: '/w',
      connectionId: TARGET,
      worktreeId: 'repo::/w',
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      ...extra
    })

    expect(recovery).toHaveBeenCalledWith(TARGET)
    expect(adopted).toBeNull()
    expect(sshProviders.has(TARGET)).toBe(true)
  })
})
