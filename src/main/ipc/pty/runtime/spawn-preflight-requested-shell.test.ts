import type * as ChildProcessModule from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { prepareRuntimePtySpawn } from './spawn-preflight'

import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { makeRuntimePtySpawnTestDeps } from './spawn-preflight-test-deps-fixture'
import { ClaudeProfileRouter } from '../../../claude-accounts/claude-profile-router'
import { installClaudeProfileRouter } from '../../../claude-accounts/claude-profile-installed-router'
import type { ClaudeManagedAccount } from '../../../../shared/managed-account-types'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV
} from '../../../../shared/claude-profile-routing'
import {
  claudeProfileMarkerPath,
  type ClaudeProfileDescriptor
} from '../../../claude-accounts/claude-profile-paths'
import type { ClaudeProfileSetupReport } from '../../../claude-accounts/claude-profile-setup'
import { resolveRuntimeClaudeAuth } from './spawn-claude-auth'

const { regQueryStdout } = vi.hoisted(() => ({ regQueryStdout: { value: '' } }))

// Answers only the OpenSSH DefaultShell registry query; every other spawn is real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return {
    ...actual,
    spawnSync: (
      file: string,
      args: readonly string[],
      options: ChildProcessModule.SpawnSyncOptions
    ) =>
      /reg\.exe$/i.test(file) && args.includes('DefaultShell')
        ? {
            pid: 0,
            output: [],
            stdout: Buffer.from(regQueryStdout.value),
            stderr: Buffer.alloc(0),
            status: regQueryStdout.value ? 0 : 1,
            signal: null
          }
        : actual.spawnSync(file, [...args], options)
  }
})

const HOST_DEFAULT_SHELL = 'powershell.exe'
const hostPlatform = process.platform

function makeDeps(): PtyRuntimeControllerDeps {
  return makeRuntimePtySpawnTestDeps(HOST_DEFAULT_SHELL)
}

describe('runtime pty spawn preflight: OpenSSH login shell on a managed SSH host (#9327)', () => {
  let loginShellDir = ''
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(loginShellDir, { recursive: true, force: true })
    Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  })

  async function resolveWithLoginShell(managed: boolean, shellOverride?: string) {
    vi.resetModules()
    loginShellDir = mkdtempSync(join(tmpdir(), 'orca-openssh-login-shell-'))
    const loginShell = join(loginShellDir, 'pwsh.exe')
    writeFileSync(loginShell, '')
    regQueryStdout.value = `HKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH\r\n    DefaultShell    REG_SZ    ${loginShell}\r\n`
    if (managed) {
      vi.stubEnv('ORCA_ORCAD_MANAGED_ACTIVATION_ROOT', loginShellDir)
    }
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const { prepareRuntimePtySpawn: prepare } = await import('./spawn-preflight')
    const { buildRuntimePtySpawnOptions: build } = await import('./spawn-options')
    const { createRuntimePtySpawnState: create } = await import('./spawn-state')
    const ctx = create(makeDeps(), { cols: 120, rows: 40, shellOverride })
    await prepare(ctx)
    await build(ctx)
    ctx.finishTerminalInstall()
    return { loginShell, shell: ctx.spawnOptions.shellOverride }
  }

  it('opens the configured login shell instead of the shipped PowerShell default', async () => {
    const { loginShell, shell } = await resolveWithLoginShell(true)

    expect(shell).toBe(loginShell)
  })
})

describe('runtime pty spawn preflight: Claude account routing in a WSL pane', () => {
  afterEach(() => {
    installClaudeProfileRouter(undefined)
    Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  })

  it('gives a wsl.exe pane the guest-relative pointer without touching the guest', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const runSetup = vi.fn()
    installClaudeProfileRouter(
      new ClaudeProfileRouter({
        getSettings: () => getDefaultSettings('/tmp'),
        dataRoot: '/data/orca',
        env: {},
        runSetup
      })
    )
    const args: RuntimePtySpawnArgs = {
      cols: 120,
      rows: 40,
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\u',
      shellOverride: 'wsl.exe',
      env: { KEEP: '1' },
      // The user's start: a background one holds until the distro is proven running (E9).
      wslUserAct: true
    }
    const ctx = createRuntimePtySpawnState(makeDeps(), args)
    await expect(prepareRuntimePtySpawn(ctx)).resolves.toBeNull()
    expect(ctx.codexSelectionTarget).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(args.env).toEqual({
      KEEP: '1',
      ORCA_CLAUDE_PROFILE_POINTER: '~/.local/share/orca/claude-profiles/selected-wsl-orca'
    })
    expect(runSetup).not.toHaveBeenCalled()
  })
})

describe('runtime pty spawn preflight: a Claude launch pinned to a named account', () => {
  const roots: string[] = []
  afterEach(() => {
    installClaudeProfileRouter(undefined)
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("carries only that account's CLAUDE_CONFIG_DIR: no selected-account pointer, no injected marker", async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-spawn-pinned-'))
    roots.push(root)
    const dataRoot = join(root, 'data')
    const account = (id: string): ClaudeManagedAccount => ({
      id,
      email: `${id}@example.test`,
      authMethod: 'subscription-oauth',
      managedAuthPath: '/unused-legacy',
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    })
    // Stands in for the setup worker: the folder and its ownership marker, prepared at once.
    const runSetup = vi.fn(
      ({ profile }: { profile: ClaudeProfileDescriptor }): Promise<ClaudeProfileSetupReport> => {
        mkdirSync(profile.home, { recursive: true })
        writeFileSync(claudeProfileMarkerPath(profile), '{}')
        return Promise.resolve({ outcome: 'prepared', warnings: [], surfaces: {} })
      }
    )
    installClaudeProfileRouter(
      new ClaudeProfileRouter({
        getSettings: () => ({
          ...getDefaultSettings('/tmp'),
          claudeManagedAccounts: [account('a'), account('b')],
          activeClaudeManagedAccountId: 'a',
          // Hooks off: setup must not probe a real Claude here.
          agentStatusHooksEnabled: false
        }),
        dataRoot,
        userHome: join(root, 'personal'),
        env: {},
        runSetup,
        refreshWaitMs: 10
      })
    )
    const args: RuntimePtySpawnArgs = {
      cols: 120,
      rows: 40,
      cwd: root,
      command: 'claude',
      claudeAccountId: 'b',
      env: { KEEP: '1' }
    }
    const ctx = createRuntimePtySpawnState(makeDeps(), args)
    // As spawnPtyFromRuntimeController does before a replacement's stop.
    const preStop = await resolveRuntimeClaudeAuth(ctx)
    ctx.claudeAuth = preStop
    await expect(prepareRuntimePtySpawn(ctx)).resolves.toBeNull()
    // Preflight reused the pre-stop preparation instead of preparing account b again.
    expect(ctx.claudeAuth).toBe(preStop)
    expect(ctx.codexSelectionTarget).toMatchObject({ runtime: 'host' })
    // The pane env still got the selected account's pointer (every host pane does)…
    expect(args.env).toHaveProperty(CLAUDE_PROFILE_POINTER_ENV)
    // …and the pinned spawn env dropped it: account b's own folder, nothing that re-routes to a.
    expect(ctx.env).toMatchObject({
      KEEP: '1',
      CLAUDE_CONFIG_DIR: join(dataRoot, 'claude-profiles', 'b', 'home')
    })
    expect(ctx.env).not.toHaveProperty(CLAUDE_PROFILE_POINTER_ENV)
    expect(ctx.env).not.toHaveProperty(CLAUDE_INJECTED_CONFIG_DIR_ENV)
    expect(ctx.claudeAuth?.provenance).toBe('profile:b')
    expect(runSetup).toHaveBeenCalledWith(
      expect.objectContaining({ profile: expect.objectContaining({ accountId: 'b' }) })
    )
  })
})
