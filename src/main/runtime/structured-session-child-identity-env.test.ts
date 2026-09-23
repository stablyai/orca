import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const shim = vi.hoisted(() => ({ ensureLinuxTerminalOrcaCliShimDir: vi.fn() }))
vi.mock('../cli/linux-terminal-orca-cli-shim', () => shim)

import {
  structuredSessionChildIdentityEnv,
  withStructuredSessionTerminalViewEnv
} from './structured-session-child-identity-env'
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

describe('structuredSessionChildIdentityEnv', () => {
  it("gives an ordinary chat session its own id and this app's CLI, and no terminal identity", () => {
    // The id names the caller, so a bare `orca orchestration check` acts as this session instead of
    // guessing a terminal — every guess landed on a sibling pane, and `check` consumed its mail.
    pinPlatform('linux')
    installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
    const childEnv = { PATH: '/usr/bin' }
    const env = structuredSessionChildIdentityEnv(SESSION_ID, childEnv)
    expect(env).toEqual({
      PATH: `${SHIM_DIR}:/usr/bin`,
      ORCA_AGENT_SESSION_ID: SESSION_ID,
      // For a CLI that predates the id, which refuses on it instead of guessing a sibling.
      ORCA_STRUCTURED_SESSION: '1',
      ORCA_CLI_COMMAND: 'orca'
    })
    // A chat names itself by its id alone: no handle, no pane key.
    expect(env.ORCA_TERMINAL_HANDLE).toBeUndefined()
    expect(env.ORCA_PANE_KEY).toBeUndefined()
    expect(childEnv).toEqual({ PATH: '/usr/bin' })
  })

  it('replaces an id inherited from an Orca launched inside another session', () => {
    installFakeAppEnvironment({ isPackaged: () => false, getPath: () => USER_DATA })
    const env = structuredSessionChildIdentityEnv(SESSION_ID, {
      ORCA_AGENT_SESSION_ID: 'a0b1c2d3-0000-4000-8000-00000000abcd',
      PATH: '/usr/bin'
    })
    expect(env.ORCA_AGENT_SESSION_ID).toBe(SESSION_ID)
  })

  it('gives a structured worker its id and keeps the handle it was minted', () => {
    // For orchestration the id wins and the host maps it back to this handle, so the worker keeps
    // one identity; the handle stays for the handle-based surfaces outside orchestration.
    installFakeAppEnvironment({ isPackaged: () => false, getPath: () => USER_DATA })
    const handle = registerWorker()
    const env = structuredSessionChildIdentityEnv(SESSION_ID, { PATH: '/usr/bin' })
    expect(env.ORCA_AGENT_SESSION_ID).toBe(SESSION_ID)
    expect(env.ORCA_TERMINAL_HANDLE).toBe(handle)
  })

  describe.each(['chat', 'worker'] as const)("reaches this app's CLI as a %s", (kind) => {
    beforeEach(() => {
      if (kind === 'worker') {
        registerWorker()
      }
    })

    it('on packaged Linux, through the bare-orca shim its ORCA_CLI_COMMAND assumes', () => {
      // Without this the child's first `orca orchestration check` execs GNOME Orca — the CLI
      // installs as `orca-ide` on Linux (stablyai/orca#7904) — and the dispatch hangs to timeout.
      pinPlatform('linux')
      installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
      const env = structuredSessionChildIdentityEnv(SESSION_ID, { PATH: '/usr/bin:/bin' })
      expect(env.ORCA_CLI_COMMAND).toBe('orca')
      expect(env.PATH).toBe(`${SHIM_DIR}:/usr/bin:/bin`)
    })

    it('on packaged macOS, through the bundled CLI dir', () => {
      pinPlatform('darwin')
      installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
      const env = structuredSessionChildIdentityEnv(SESSION_ID, { PATH: '/usr/bin' })
      expect(env.PATH).toBe(`${join(RESOURCES, 'bin')}:/usr/bin`)
    })

    it('on packaged Windows, through the bundled CLI dir under the env block spelling', () => {
      pinPlatform('win32')
      installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
      const env = structuredSessionChildIdentityEnv(SESSION_ID, { Path: 'C:\\Windows' })
      expect(env.Path).toBe(`${join(RESOURCES, 'bin')};C:\\Windows`)
      expect(env.PATH).toBeUndefined()
    })

    it('unpackaged, through the dev launcher dir', () => {
      pinPlatform('darwin')
      installFakeAppEnvironment({ isPackaged: () => false, getPath: () => USER_DATA })
      const env = structuredSessionChildIdentityEnv(SESSION_ID, { PATH: '/usr/bin' })
      expect(env.PATH).toBe(`${join(USER_DATA, 'cli', 'bin')}:/usr/bin`)
    })
  })

  it("gives the terminal view the same id, and leaves any other terminal's env as given", () => {
    expect(withStructuredSessionTerminalViewEnv({ CLAUDE_CONFIG_DIR: '/c' }, SESSION_ID)).toEqual({
      CLAUDE_CONFIG_DIR: '/c',
      ORCA_AGENT_SESSION_ID: SESSION_ID
    })
    expect(withStructuredSessionTerminalViewEnv(undefined, SESSION_ID)).toEqual({
      ORCA_AGENT_SESSION_ID: SESSION_ID
    })
    const plain = { CLAUDE_CONFIG_DIR: '/c' }
    expect(withStructuredSessionTerminalViewEnv(plain, undefined)).toBe(plain)
    expect(withStructuredSessionTerminalViewEnv(undefined, undefined)).toBeUndefined()
  })

  it('never puts a pane key in the child environment', () => {
    // A pane key here flows into hook-emitted agent statuses and the attestation, agent-row and
    // mobile-projection pipelines, all of which assume it names a live PTY leaf.
    pinPlatform('linux')
    installFakeAppEnvironment({ isPackaged: () => true, getPath: () => USER_DATA })
    registerWorker()
    const env = structuredSessionChildIdentityEnv(SESSION_ID, { PATH: '/usr/bin' })
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
      structuredSessionChildIdentityEnv(SESSION_ID, { PATH: '/usr/bin' }).ORCA_CLI_COMMAND
    ).not.toBe('orca-ide')
  })
})
