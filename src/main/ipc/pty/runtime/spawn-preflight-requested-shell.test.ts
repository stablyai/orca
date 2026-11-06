import type * as ChildProcessModule from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
