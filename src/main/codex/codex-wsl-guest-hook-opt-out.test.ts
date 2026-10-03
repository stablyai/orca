import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcess from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execFileSpy = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return { ...actual, execFile: execFileSpy.mockImplementation(actual.execFile) }
})

import { readHookTrustEntries } from './config-toml-trust'
import { _internals, type CodexWslRuntimeHookInstallPlan } from './hook-service'
import {
  restoreCodexTrustSessionsForTests,
  stubCodexTrustSessionsForTests
} from './hook-service-test-harness'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import {
  createWslGuestCodexHookOptOutPlan,
  withdrawWslGuestCodexHooksForOptOut
} from './codex-wsl-guest-hook-opt-out'

type HooksConfig = { hooks: Record<string, { hooks?: { command?: string }[] }[]> }

const USER_COMMAND = '/bin/sh /home/alice/user-hook.sh'
let tempRoots: string[] = []

beforeEach(() => {
  // Why: the trust-grant ledger lives in Orca's userData, which otherwise resolves to the live one.
  const userData = mkdtempSync(join(tmpdir(), 'orca-codex-wsl-opt-out-userdata-'))
  tempRoots.push(userData)
  vi.stubEnv('ORCA_USER_DATA_PATH', userData)
  // Why: on Windows the grant would otherwise run codex inside a real distro.
  stubCodexTrustSessionsForTests()
})

afterEach(() => {
  restoreCodexTrustSessionsForTests()
  vi.unstubAllEnvs()
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  tempRoots = []
})

/** A stand-in for one running distro's own ~/.codex. */
function createGuestCodexHome(): CodexWslRuntimeHookInstallPlan {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-wsl-guest-home-'))
  tempRoots.push(root)
  const linuxHome = '/home/alice/.codex'
  return {
    configPath: join(root, 'hooks.json'),
    tomlPath: join(root, 'config.toml'),
    scriptPath: join(root, '.orca', 'agent-hooks', 'codex-hook.sh'),
    commandScriptPath: `${linuxHome}/.orca/agent-hooks/codex-hook.sh`,
    trustConfigPath: `${linuxHome}/hooks.json`,
    wslDistro: 'Ubuntu',
    linuxRuntimeHome: linuxHome
  }
}

function writeUserHooks(plan: CodexWslRuntimeHookInstallPlan): void {
  writeFileSync(
    plan.configPath,
    `${JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: USER_COMMAND }] }] }
    })}\n`,
    'utf-8'
  )
}

function commands(plan: CodexWslRuntimeHookInstallPlan): string[] {
  const config: HooksConfig = JSON.parse(readFileSync(plan.configPath, 'utf-8'))
  return Object.values(config.hooks).flatMap((definitions) =>
    definitions.flatMap((definition) => (definition.hooks ?? []).map((hook) => hook.command ?? ''))
  )
}

function orcaTrustKeys(plan: CodexWslRuntimeHookInstallPlan): string[] {
  return [...readHookTrustEntries(plan.tomlPath).keys()].filter((key) =>
    key.startsWith(plan.trustConfigPath)
  )
}

describe("Codex hooks opt-out in a WSL guest's own ~/.codex", () => {
  it("removes Orca's entries and trust and keeps the user's hooks", async () => {
    const guest = createGuestCodexHome()
    writeUserHooks(guest)
    expect((await _internals.installManagedHooksIntoWslRuntime(guest)).state).toBe('installed')
    expect(commands(guest).some((command) => command.includes('codex-hook.sh'))).toBe(true)

    await withdrawWslGuestCodexHooksForOptOut(async () => [guest])

    expect(commands(guest)).toEqual([USER_COMMAND])
    expect(orcaTrustKeys(guest)).toEqual([])
  })

  it('is restored by another Orca with hooks on at its next WSL launch', async () => {
    const guest = createGuestCodexHome()
    writeUserHooks(guest)
    await _internals.installManagedHooksIntoWslRuntime(guest)
    const installedCommands = commands(guest)
    const installedTrust = orcaTrustKeys(guest)
    await withdrawWslGuestCodexHooksForOptOut(async () => [guest])

    // Hooks-on launch prep for a WSL home runs this same install on every pane spawn.
    expect((await _internals.installManagedHooksIntoWslRuntime(guest)).state).toBe('installed')

    expect(commands(guest)).toEqual(installedCommands)
    expect(orcaTrustKeys(guest)).toEqual(installedTrust)
  })

  it('lets a hooks-on install already queued on the guest config land, then removes it', async () => {
    const guest = createGuestCodexHome()
    writeUserHooks(guest)
    let releaseLane!: () => void
    const laneHeld = runExclusivelyForCodexTrustConfig(
      guest.tomlPath,
      () => new Promise<void>((resolve) => (releaseLane = resolve))
    )
    const install = _internals.installManagedHooksIntoWslRuntime(guest)

    const withdrawal = withdrawWslGuestCodexHooksForOptOut(async () => [guest])
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseLane()
    await Promise.all([laneHeld, install, withdrawal])

    expect(commands(guest)).toEqual([USER_COMMAND])
    expect(orcaTrustKeys(guest)).toEqual([])
  })

  it('leaves a guest that holds no Orca entry exactly as it was', async () => {
    const withoutCodexConfig = createGuestCodexHome()
    const withUserHooksOnly = createGuestCodexHome()
    writeUserHooks(withUserHooksOnly)
    const before = readFileSync(withUserHooksOnly.configPath, 'utf-8')

    await withdrawWslGuestCodexHooksForOptOut(async () => [withoutCodexConfig, withUserHooksOnly])

    expect(existsSync(withoutCodexConfig.configPath)).toBe(false)
    expect(existsSync(withoutCodexConfig.tomlPath)).toBe(false)
    expect(readFileSync(withUserHooksOnly.configPath, 'utf-8')).toBe(before)
    expect(existsSync(withUserHooksOnly.tomlPath)).toBe(false)
  })
})

describe('the opt-out plan for a running distro', () => {
  it("targets the guest's own ~/.codex without probing WSL", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    // Why: off Windows the canonical-path probe is skipped anyway; on Windows it spawns wsl.exe.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    execFileSpy.mockClear()
    try {
      const plan = createWslGuestCodexHookOptOutPlan({
        distro: 'Ubuntu',
        guestHome: '\\\\wsl.localhost\\Ubuntu\\home\\alice'
      })

      expect(plan).toMatchObject({
        configPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex\\hooks.json',
        tomlPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex\\config.toml',
        trustConfigPath: '/home/alice/.codex/hooks.json',
        wslDistro: 'Ubuntu',
        linuxRuntimeHome: '/home/alice/.codex'
      })
      expect(execFileSpy).not.toHaveBeenCalled()
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })
})
