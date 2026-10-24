import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeOs from 'node:os'

const { handleMock, removeHandlerMock, homedirMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: homedirMock }
})

import { registerCodexConfigSyncHandlers } from './codex-config-sync'
import type { CodexConfigSyncStatus } from '../../shared/codex-config-sync-types'
import { getCodexSettingsBaselinePath } from '../codex/config-settings-baseline'

let root: string

function invokeHandler(mirroredHome: string | null): CodexConfigSyncStatus {
  return invokeHandlerWithStatus({ kind: 'ready', homePath: mirroredHome })
}

function invokeHandlerWithStatus(
  mirrored: { kind: 'ready'; homePath: string | null } | { kind: 'unavailable' }
): CodexConfigSyncStatus {
  handleMock.mockClear()
  registerCodexConfigSyncHandlers({
    getMirroredHostHomePathForStatus: () => mirrored
  })
  const handler = handleMock.mock.calls.at(-1)?.[1] as () => CodexConfigSyncStatus
  return handler()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-config-sync-ipc-'))
  homedirMock.mockReturnValue(root)
  mkdirSync(join(root, '.codex'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('codexConfigSync:status handler', () => {
  it('reports the stall for the home the current selection actually mirrors into', () => {
    // Managed accounts mirror per-account homes, not the shared runtime home.
    const perAccountHome = join(root, 'codex-accounts', 'acct-1', 'home')
    mkdirSync(perAccountHome, { recursive: true })
    writeFileSync(join(perAccountHome, 'config.toml'), 'model = "runtime-model"\n', 'utf-8')

    expect(invokeHandler(perAccountHome)).toEqual({
      state: 'stalled',
      reason: 'missing-source',
      systemConfigPath: join(root, '.codex', 'config.toml')
    })
  })

  it('reports synced when the selection runs directly on the real home', () => {
    // System default uses no mirror; stale shared homes must not produce warnings.
    const staleSharedHome = join(root, 'codex-runtime-home', 'home')
    mkdirSync(staleSharedHome, { recursive: true })
    writeFileSync(join(staleSharedHome, 'config.toml'), 'model = "stale"\n', 'utf-8')

    expect(invokeHandler(null)).toEqual({
      state: 'synced',
      reason: null,
      systemConfigPath: join(root, '.codex', 'config.toml')
    })
  })

  it('reports a stall when the selected home baseline cannot be read', () => {
    const perAccountHome = join(root, 'codex-accounts', 'acct-1', 'home')
    mkdirSync(perAccountHome, { recursive: true })
    writeFileSync(join(perAccountHome, 'config.toml'), 'model = "runtime-model"\n', 'utf-8')
    writeFileSync(join(root, '.codex', 'config.toml'), 'model = "system-model"\n', 'utf-8')
    const baselinePath = getCodexSettingsBaselinePath(perAccountHome)
    mkdirSync(baselinePath)

    expect(invokeHandler(perAccountHome)).toEqual({
      state: 'stalled',
      reason: 'managed-home-unavailable',
      systemConfigPath: join(root, '.codex', 'config.toml'),
      managedStatePath: baselinePath
    })
  })

  it('re-registers cleanly so a reload cannot leak a duplicate handler', () => {
    invokeHandler(null)
    expect(removeHandlerMock).toHaveBeenCalledWith('codexConfigSync:status')
  })
})

// Unreadable managed homes must not collapse into the healthy no-mirror state (STA-4422).
it('reports a managed-home-unavailable stall instead of synced when the home is unreadable', () => {
  expect(invokeHandlerWithStatus({ kind: 'ready', homePath: null })).toEqual({
    state: 'synced',
    reason: null,
    systemConfigPath: join(root, '.codex', 'config.toml')
  })

  expect(invokeHandlerWithStatus({ kind: 'unavailable' })).toEqual({
    state: 'stalled',
    reason: 'managed-home-unavailable',
    systemConfigPath: join(root, '.codex', 'config.toml')
  })
})
