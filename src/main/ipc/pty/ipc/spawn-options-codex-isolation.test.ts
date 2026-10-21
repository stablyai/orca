import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { buildRuntimePtySpawnOptions } from '../runtime/spawn-options'
import { createRuntimePtySpawnState } from '../runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from '../runtime/controller-deps'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcDeps } from './spawn-types'

function settingsWith(isolation: boolean | undefined): GlobalSettings {
  const settings = getDefaultSettings('/tmp')
  if (isolation === undefined) {
    delete settings.codexTerminalServerIsolation
    return settings
  }
  return { ...settings, codexTerminalServerIsolation: isolation }
}

async function ipcSpawnEnv(
  isolation: boolean | undefined,
  connectionId: string | null
): Promise<Record<string, string> | undefined> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: buildPtyIpcSpawnOptions only reads the members stubbed here; the rest belong to later spawn stages this test never runs.
  const deps = {
    transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
    getSettings: () => settingsWith(isolation),
    runtime: { registerPreAllocatedHandleForPty: vi.fn() }
  } as unknown as PtySpawnIpcDeps
  const ctx = createPtyIpcSpawnState(deps, { cols: 80, rows: 24, connectionId })
  ctx.env = { KEEP: '1' }
  await buildPtyIpcSpawnOptions(ctx)
  return ctx.spawnOptions.env
}

async function runtimeSpawnEnv(
  isolation: boolean | undefined,
  connectionId: string | null
): Promise<Record<string, string> | undefined> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: buildRuntimePtySpawnOptions only reads getSettings here; the rest belong to later spawn stages this test never runs.
  const deps = { getSettings: () => settingsWith(isolation) } as unknown as PtyRuntimeControllerDeps
  const ctx = createRuntimePtySpawnState(deps, { cols: 80, rows: 24, connectionId })
  ctx.env = { KEEP: '1' }
  await buildRuntimePtySpawnOptions(ctx)
  return ctx.spawnOptions.env
}

// Why both hosts: SSH panes reach the relay with this env untouched, local ones reach
// node-pty or the daemon; WSL forwarding is covered by wsl-orca-env.test.ts.
describe.each([
  ['renderer spawn', ipcSpawnEnv],
  ['runtime spawn', runtimeSpawnEnv]
])('%s: Codex terminal server isolation', (_name, spawnEnv) => {
  it.each([null, 'ssh-1'])(
    'injects nothing while the setting is on (connection %s)',
    async (id) => {
      expect(await spawnEnv(true, id)).toEqual({ KEEP: '1' })
      expect(await spawnEnv(undefined, id)).toEqual({ KEEP: '1' })
    }
  )

  it.each([null, 'ssh-1'])(
    'opts new terminals out with ORCA_CODEX_ISOLATE=0 when off (connection %s)',
    async (id) => {
      expect(await spawnEnv(false, id)).toEqual({ KEEP: '1', ORCA_CODEX_ISOLATE: '0' })
    }
  )
})
