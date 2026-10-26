import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import {
  SERVE_UPDATE_HANDOFF_PATH_ENV,
  getServeUpdateHandoffPath
} from '../shared/serve-update-handoff'

// Keep the real path resolver: mocking persistence hides access before app-environment setup.
vi.mock('electron', () => ({ app: { getVersion: () => '1.0.51', quit: vi.fn() } }))

// Test setup installs a fake environment, and there is no uninstall API.
const APP_ENVIRONMENT_SLOT = Symbol.for('orca.host.appEnvironment')

describe('serve supervisor disconnect quit', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  let installedEnvironment: unknown
  let installedHandoffPath: string | undefined
  let userDataDir: string

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-serve-handoff-env-'))
    installedHandoffPath = process.env[SERVE_UPDATE_HANDOFF_PATH_ENV]
    const slot = globalThis as Record<symbol, unknown>
    installedEnvironment = slot[APP_ENVIRONMENT_SLOT]
    delete slot[APP_ENVIRONMENT_SLOT]
    // The supervisor check short-circuits on other platforms.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    process.env[SERVE_UPDATE_HANDOFF_PATH_ENV] = getServeUpdateHandoffPath(userDataDir)
  })

  afterEach(() => {
    const slot = globalThis as Record<symbol, unknown>
    if (installedEnvironment === undefined) {
      delete slot[APP_ENVIRONMENT_SLOT]
    } else {
      slot[APP_ENVIRONMENT_SLOT] = installedEnvironment
    }
    Object.defineProperty(process, 'platform', originalPlatform)
    if (installedHandoffPath === undefined) {
      delete process.env[SERVE_UPDATE_HANDOFF_PATH_ENV]
    } else {
      process.env[SERVE_UPDATE_HANDOFF_PATH_ENV] = installedHandoffPath
    }
    rmSync(userDataDir, { recursive: true, force: true })
    vi.resetModules()
  })

  it('resolves a real user data path, so it cannot run before the app environment is installed', async () => {
    const { installServeSupervisorDisconnectQuit } = await import('./serve-update-handoff')

    expect(() => installServeSupervisorDisconnectQuit(true)).toThrow(
      /AppEnvironment not initialized/
    )
  })

  it('installs the disconnect quit once the app environment is available', async () => {
    installFakeAppEnvironment({ getPath: () => userDataDir })
    const { installServeSupervisorDisconnectQuit } = await import('./serve-update-handoff')
    const listeners: (() => void)[] = []
    const parent = {
      once: (_event: 'disconnect', listener: () => void) => listeners.push(listener),
      off: (_event: 'disconnect', listener: () => void) =>
        listeners.splice(listeners.indexOf(listener), 1)
    }

    const dispose = installServeSupervisorDisconnectQuit(true, parent)

    expect(listeners).toHaveLength(1)
    dispose()
    expect(listeners).toHaveLength(0)
  })
})
