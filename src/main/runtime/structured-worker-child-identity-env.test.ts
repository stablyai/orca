import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const shim = vi.hoisted(() => ({ ensureLinuxTerminalOrcaCliShimDir: vi.fn() }))
vi.mock('../cli/linux-terminal-orca-cli-shim', () => shim)

import { structuredWorkerChildIdentityEnv } from './structured-worker-child-identity-env'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerHostScope,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from './structured-worker-identity'

const SESSION_ID = 'f7a1c0de-1111-4222-8333-444455556666'
const USER_DATA = '/data/orca'
const RESOURCES = '/app/Resources'
const SHIM_DIR = join(USER_DATA, 'linux-orca-cli-shim')

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

function pinPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function registerWorker(): string {
  const handle = mintStructuredWorkerHandle()
  structuredWorkerIdentities.register({
    handle,
    sessionId: SESSION_ID,
    agent: 'claude',
    paneKey: mintStructuredWorkerPaneKey(SESSION_ID),
    processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
    worktreeId: 'wt_1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
  return handle
}

beforeEach(() => {
  shim.ensureLinuxTerminalOrcaCliShimDir.mockReset()
  shim.ensureLinuxTerminalOrcaCliShimDir.mockReturnValue(SHIM_DIR)
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: RESOURCES })
})

afterEach(() => {
  structuredWorkerIdentities.clear()
  Object.defineProperty(process, 'platform', platformDescriptor)
  if (resourcesDescriptor) {
    Object.defineProperty(process, 'resourcesPath', resourcesDescriptor)
  } else {
    Reflect.deleteProperty(process, 'resourcesPath')
  }
})

describe('structuredWorkerChildIdentityEnv', () => {
  it('marks an ordinary chat session as having NO identity, and grants it nothing', () => {
    // The marker names nothing — no handle, no pane key, no session id, no token — so it cannot be
    // replayed or impersonated, and it does not reach the hook, agent-row or mobile-projection
    // pipelines a pane key would. Its only job is to let the CLI REFUSE instead of guessing: this
    // session has no pane, so every implicit-terminal guess resolved to a sibling, and a
    // destructive `check` then consumed that sibling's mail.
    pinPlatform('linux')
    installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
    const childEnv = { PATH: '/usr/bin' }
    const env = structuredWorkerChildIdentityEnv(SESSION_ID, childEnv)
    expect(env).toEqual({ PATH: '/usr/bin', ORCA_STRUCTURED_SESSION: '1' })
    expect(env.ORCA_TERMINAL_HANDLE).toBeUndefined()
    expect(env.ORCA_PANE_KEY).toBeUndefined()
    expect(env.ORCA_CLI_COMMAND).toBeUndefined()
    // Still no CLI reachability granted, so packaged builds keep today's exposure.
    expect(childEnv.PATH).toBe('/usr/bin')
    expect(shim.ensureLinuxTerminalOrcaCliShimDir).not.toHaveBeenCalled()
  })

  it('gives a packaged-Linux worker the bare-orca shim its ORCA_CLI_COMMAND assumes', () => {
    // Without this the child's first `orca orchestration check` execs GNOME Orca — the CLI
    // installs as `orca-ide` on Linux (stablyai/orca#7904) — and the dispatch hangs to timeout.
    pinPlatform('linux')
    installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
    const handle = registerWorker()
    const env = structuredWorkerChildIdentityEnv(SESSION_ID, { PATH: '/usr/bin:/bin' })
    expect(env.ORCA_TERMINAL_HANDLE).toBe(handle)
    expect(env.ORCA_CLI_COMMAND).toBe('orca')
    expect(env.PATH).toBe(`${SHIM_DIR}:/usr/bin:/bin`)
  })

  it('gives a packaged-macOS worker the bundled CLI dir', () => {
    pinPlatform('darwin')
    installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
    registerWorker()
    const env = structuredWorkerChildIdentityEnv(SESSION_ID, { PATH: '/usr/bin' })
    expect(env.PATH).toBe(`${join(RESOURCES, 'bin')}:/usr/bin`)
  })

  it('gives a packaged-Windows worker the bundled CLI dir under the env block spelling', () => {
    pinPlatform('win32')
    installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
    registerWorker()
    const env = structuredWorkerChildIdentityEnv(SESSION_ID, { Path: 'C:\\Windows' })
    expect(env.Path).toBe(`${join(RESOURCES, 'bin')};C:\\Windows`)
    expect(env.PATH).toBeUndefined()
  })

  it('gives an unpackaged worker the dev launcher dir', () => {
    pinPlatform('darwin')
    installFakeAppEnvironment({ isPackaged: () => false, getPath: () => USER_DATA })
    registerWorker()
    const env = structuredWorkerChildIdentityEnv(SESSION_ID, { PATH: '/usr/bin' })
    expect(env.PATH).toBe(`${join(USER_DATA, 'cli', 'bin')}:/usr/bin`)
  })

  it('never puts a pane key in the child environment', () => {
    // A pane key here flows into hook-emitted agent statuses and the attestation, agent-row and
    // mobile-projection pipelines, all of which assume it names a live PTY leaf.
    pinPlatform('linux')
    installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
    registerWorker()
    const env = structuredWorkerChildIdentityEnv(SESSION_ID, { PATH: '/usr/bin' })
    expect(env.ORCA_PANE_KEY).toBeUndefined()
    expect(Object.keys(env).filter((key) => key.includes('PANE'))).toEqual([])
  })

  it('never names the WSL-scoped launcher, because a structured worker cannot run in WSL', () => {
    // `orca-ide` is the literal the PTY lane exports for WSL only. A structured session that
    // resolves to a WSL distro is refused a host scope, so it never becomes a worker at all —
    // which is why the bare-`orca` shim, not the literal, is the right fix on Linux.
    expect(
      structuredWorkerHostScope({
        executionHostId: 'local',
        workspaceId: 'wt_1',
        workspaceKind: 'git-worktree',
        wslDistro: 'Ubuntu'
      })
    ).toBeNull()
    pinPlatform('linux')
    installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
    registerWorker()
    expect(
      structuredWorkerChildIdentityEnv(SESSION_ID, { PATH: '/usr/bin' }).ORCA_CLI_COMMAND
    ).not.toBe('orca-ide')
  })
})
