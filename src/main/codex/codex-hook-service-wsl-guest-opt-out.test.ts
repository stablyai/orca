import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as InstallPlan from './codex-wsl-hook-install-plan'
import { setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock, guest } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>(),
  guest: { root: '', pendingSettles: new Array<InstallPlan.WslCanonicalPathSettled>() }
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: homedirMock }
})
// Why: a guest's UNC home is not a file on this OS. Keep the real plan, move
// its files into a temp dir, and hold the canonical-path settle for the test.
vi.mock('./codex-wsl-hook-install-plan', async (importOriginal) => {
  const actual = await importOriginal<typeof InstallPlan>()
  return {
    ...actual,
    createCodexWslRuntimeHookInstallPlan: (
      ...args: Parameters<typeof actual.createCodexWslRuntimeHookInstallPlan>
    ) => {
      const onSettled = args[3]
      if (onSettled) {
        guest.pendingSettles.push(onSettled)
      }
      const plan = actual.createCodexWslRuntimeHookInstallPlan(...args)
      return (
        plan && {
          ...plan,
          configPath: join(guest.root, 'hooks.json'),
          tomlPath: join(guest.root, 'config.toml'),
          scriptPath: join(guest.root, '.orca', 'agent-hooks', 'codex-hook.sh')
        }
      )
    }
  }
})

import { CodexHookService } from './hook-service'
import {
  setWslGuestCodexHookOptOutSources,
  type RunningWslGuest
} from './codex-wsl-guest-hook-opt-out'
import { readHookTrustEntries } from './config-toml-trust'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'

type HooksConfig = { hooks: Record<string, { hooks?: { command?: string }[] }[]> }

const GUEST_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\alice'
const GUEST_CODEX_HOME = `${GUEST_HOME}\\.codex`
const WSL_TARGET = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
const MOVED_CODEX_HOME = '/mnt/wsl/alice/.codex'
const USER_COMMAND = '/bin/sh /home/alice/user-hook.sh'
const RUNNING_GUEST: RunningWslGuest = { distro: 'Ubuntu', guestHome: GUEST_HOME }
let codexHooksEnabled = false

setupCodexHookHomes(homedirMock, getPathMock)

beforeEach(() => {
  guest.root = mkdtempSync(join(tmpdir(), 'orca-codex-wsl-guest-'))
  guest.pendingSettles = []
  writeFileSync(
    join(guest.root, 'hooks.json'),
    `${JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: USER_COMMAND }] }] }
    })}\n`,
    'utf-8'
  )
  codexHooksEnabled = false
  useRunningGuests(async () => [RUNNING_GUEST])
})

afterEach(() => {
  setWslGuestCodexHookOptOutSources({
    listRunningGuests: async () => [],
    isCodexHooksEnabled: () => false
  })
  rmSync(guest.root, { recursive: true, force: true })
})

function useRunningGuests(listRunningGuests: () => Promise<RunningWslGuest[]>): void {
  setWslGuestCodexHookOptOutSources({
    listRunningGuests,
    isCodexHooksEnabled: () => codexHooksEnabled
  })
}

function hasOrcaEntry(): boolean {
  return guestCommands().some((command) => command.includes('codex-hook.sh'))
}

function guestCommands(): string[] {
  const config: HooksConfig = JSON.parse(readFileSync(join(guest.root, 'hooks.json'), 'utf-8'))
  return Object.values(config.hooks).flatMap((definitions) =>
    definitions.flatMap((definition) => (definition.hooks ?? []).map((hook) => hook.command ?? ''))
  )
}

function guestTrustSources(): string[] {
  return [...readHookTrustEntries(join(guest.root, 'config.toml')).keys()].map(
    (key) => key.split(':')[0]
  )
}

function snapshotGuest(): { hooks: string; toml: string } {
  return {
    hooks: readFileSync(join(guest.root, 'hooks.json'), 'utf-8'),
    toml: readFileSync(join(guest.root, 'config.toml'), 'utf-8')
  }
}

async function installAsHooksOnLaunch(service: CodexHookService): Promise<void> {
  const status = await service.prepareRuntimeHomeForLaunch(
    GUEST_CODEX_HOME,
    WSL_TARGET,
    true,
    'shared'
  )
  expect(status?.state).toBe('installed')
  expect(hasOrcaEntry()).toBe(true)
  expect(guestTrustSources()).toContain('/home/alice/.codex/hooks.json')
  expect(guest.pendingSettles).toHaveLength(1)
}

/** WSL reports the home's canonical path late, as `readlink -f` over wsl.exe does. */
async function settleCanonicalPath(canonicalPath: string): Promise<void> {
  for (const settle of guest.pendingSettles.splice(0)) {
    settle({ status: 'resolved', canonicalPath })
  }
  // Why: the reconcile hops a promise chain, then queues its install on the config's lane.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await runExclusivelyForCodexTrustConfig(join(guest.root, 'config.toml'), async () => {})
}

describe("Codex hooks opt-out reaching a running distro's own ~/.codex", () => {
  it("removes Orca's entry and trust and keeps the user's hooks", async () => {
    const service = new CodexHookService()
    await installAsHooksOnLaunch(service)

    await service.remove()
    await service.whenWslGuestOptOutSettled()

    expect(guestCommands()).toEqual([USER_COMMAND])
    expect(guestTrustSources()).toEqual([])
  })

  it('a late canonical path reinstalls at that path while hooks stay on', async () => {
    const service = new CodexHookService()
    await installAsHooksOnLaunch(service)

    await settleCanonicalPath(MOVED_CODEX_HOME)

    expect(guestTrustSources()).toContain(`${MOVED_CODEX_HOME}/hooks.json`)
  })

  it('a late canonical path does not reinstall after the opt-out', async () => {
    const service = new CodexHookService()
    await installAsHooksOnLaunch(service)
    await service.remove()
    await service.whenWslGuestOptOutSettled()

    await settleCanonicalPath(MOVED_CODEX_HOME)

    expect(guestCommands()).toEqual([USER_COMMAND])
    expect(guestTrustSources()).toEqual([])
  })

  it('a hooks-off launch leaves the shared home alone and cancels the pending reinstall', async () => {
    const service = new CodexHookService()
    await installAsHooksOnLaunch(service)
    const before = snapshotGuest()

    await expect(
      service.prepareRuntimeHomeForLaunch(GUEST_CODEX_HOME, WSL_TARGET, false, 'shared')
    ).resolves.toBeNull()
    expect(snapshotGuest()).toEqual(before)

    await settleCanonicalPath(MOVED_CODEX_HOME)

    expect(snapshotGuest()).toEqual(before)
  })

  it('resolves the toggle before a slow WSL is reached, then withdraws', async () => {
    const service = new CodexHookService()
    await installAsHooksOnLaunch(service)
    let releaseGuests!: () => void
    useRunningGuests(
      () => new Promise((resolve) => (releaseGuests = () => resolve([RUNNING_GUEST])))
    )

    const removed = await Promise.race([
      service.remove(),
      new Promise((resolve) => setTimeout(() => resolve('still waiting on WSL'), 5000))
    ])

    expect(removed).toMatchObject({ agent: 'codex' })
    expect(hasOrcaEntry()).toBe(true)
    releaseGuests()
    await service.whenWslGuestOptOutSettled()
    expect(guestCommands()).toEqual([USER_COMMAND])
    expect(guestTrustSources()).toEqual([])
  })

  it('keeps the entry when hooks are turned back on before the withdrawal reaches the guest', async () => {
    const service = new CodexHookService()
    await installAsHooksOnLaunch(service)
    const before = snapshotGuest()
    let releaseLane!: () => void
    const laneHeld = runExclusivelyForCodexTrustConfig(
      join(guest.root, 'config.toml'),
      () => new Promise<void>((resolve) => (releaseLane = resolve))
    )

    await service.remove()
    await new Promise((resolve) => setTimeout(resolve, 0))
    codexHooksEnabled = true
    releaseLane()
    await laneHeld
    await service.whenWslGuestOptOutSettled()

    expect(snapshotGuest()).toEqual(before)
  })

  it('warns and still resolves with the host status when WSL cannot be listed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unreachable = new Error('WSL running-distro discovery is unavailable.')
    useRunningGuests(async () => {
      throw unreachable
    })
    const service = new CodexHookService()

    await expect(service.remove()).resolves.toMatchObject({ agent: 'codex' })
    await expect(service.whenWslGuestOptOutSettled()).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith(
      '[codex-hook-service] failed to remove WSL Codex hooks:',
      unreachable
    )
    warn.mockRestore()
  })

  it('runs a second opt-out after the first instead of beside it', async () => {
    const service = new CodexHookService()
    const releases: (() => void)[] = []
    useRunningGuests(() => new Promise((resolve) => releases.push(() => resolve([]))))

    await service.remove()
    await service.remove()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(releases).toHaveLength(1)

    releases[0]()
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[1]()
    await service.whenWslGuestOptOutSettled()
  })
})
