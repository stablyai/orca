import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import {
  SERVE_UPDATE_HANDOFF_PATH_ENV,
  getServeUpdateHandoffPath
} from '../shared/serve-update-handoff'

/**
 * Runtime companion to the source-level ordering guard in
 * startup/desktop-startup-ordering.test.ts (issue #16761).
 *
 * The sibling serve-update-handoff.test.ts mocks `./persistence`, so under it
 * getCanonicalUserDataPath() can never throw — which is exactly why a module-scope call to
 * installServeSupervisorDisconnectQuit() shipped and killed every `orca serve` process on
 * macOS. This file keeps the real path resolver so that dependency stays visible.
 */
vi.mock('electron', () => ({ app: { getVersion: () => '1.0.51', quit: vi.fn() } }))

// Why reach for the slot directly: there is no uninstall API, and vitest-host-ports-setup installs
// a fake before every test — so the uninstalled state this guards can only be reproduced this way.
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
    // Why pin darwin: hasServeUpdateSupervisor() short-circuits off-macOS, so the guard would
    // silently cover nothing on Linux/Windows CI — where this suite actually runs.
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
    // Why restore rather than delete: this suite can run inside a serve process that set it.
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
