import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import {
  computeTrustKey,
  computeTrustedHash,
  readHookTrustEntries,
  upsertHookTrustEntriesInContent,
  type CodexTrustEntry
} from './config-toml-trust'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { CodexHookService } from './hook-service'

let tmpHome: string
let userDataDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-codex-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(tmpHome)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

const USER_HOOK_COMMAND = 'echo my-personal-hook'

function systemCodexDir(): string {
  return join(tmpHome, '.codex')
}

function runtimeHomeDir(): string {
  return join(userDataDir, 'codex-runtime-home', 'home')
}

function writeSystemUserHook(commands: string[] = [USER_HOOK_COMMAND]): void {
  mkdirSync(systemCodexDir(), { recursive: true })
  writeFileSync(
    join(systemCodexDir(), 'hooks.json'),
    JSON.stringify({
      hooks: {
        Stop: commands.map((command) => ({ hooks: [{ type: 'command', command }] }))
      }
    })
  )
}

// Simulates the Codex TUI persisting a /hooks approval: Codex writes a trust
// entry keyed to the file that declares the hook, using its own hash. The
// production hash algorithm is reproduced by computeTrustedHash.
function simulateCodexApproval(entry: CodexTrustEntry, options?: { hash?: string }): void {
  const tomlPath = join(runtimeHomeDir(), 'config.toml')
  const existing = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf-8') : ''
  const approvalEntry = options?.hash ? { ...entry, trustedHash: options.hash } : entry
  writeFileSync(tomlPath, upsertHookTrustEntriesInContent(existing, [approvalEntry]))
}

function runtimeUserStopEntry(): CodexTrustEntry {
  // install() prepends the managed status hook on Stop, so the mirrored user
  // hook lands at groupIndex 1.
  return {
    sourcePath: join(runtimeHomeDir(), 'hooks.json'),
    eventLabel: 'stop',
    groupIndex: 1,
    handlerIndex: 0,
    command: USER_HOOK_COMMAND
  }
}

function systemUserStopEntry(groupIndex = 0): CodexTrustEntry {
  return {
    sourcePath: join(systemCodexDir(), 'hooks.json'),
    eventLabel: 'stop',
    groupIndex,
    handlerIndex: 0,
    command: USER_HOOK_COMMAND
  }
}

function readSystemToml(): string {
  const tomlPath = join(systemCodexDir(), 'config.toml')
  return existsSync(tomlPath) ? readFileSync(tomlPath, 'utf-8') : ''
}

describe('codex hook trust write-back promotion', () => {
  it('keeps an in-Orca approval of a user hook across launches and promotes it to ~/.codex', () => {
    writeSystemUserHook()
    const service = new CodexHookService()
    service.install()

    // The mirrored user hook has no system trust yet, so no runtime trust
    // entry exists for it — Codex would show it as pending review.
    const runtimeTomlPath = join(runtimeHomeDir(), 'config.toml')
    const approvalKey = computeTrustKey(runtimeUserStopEntry())
    expect(readHookTrustEntries(runtimeTomlPath).get(approvalKey)).toBeUndefined()

    simulateCodexApproval(runtimeUserStopEntry())
    const approvedHash = computeTrustedHash(runtimeUserStopEntry())

    service.install()

    // Approval survives the relaunch instead of being wiped as stale…
    expect(readHookTrustEntries(runtimeTomlPath).get(approvalKey)?.trustedHash).toBe(approvedHash)
    // …and is promoted into the user's real config keyed to their hooks.json.
    const systemState = readHookTrustEntries(join(systemCodexDir(), 'config.toml')).get(
      computeTrustKey(systemUserStopEntry())
    )
    expect(systemState?.trustedHash).toBe(approvedHash)
    expect(systemState?.enabled).not.toBe(false)

    // Steady state: another launch with no external changes rewrites nothing.
    const systemTomlAfterPromotion = readSystemToml()
    const runtimeTomlAfterPromotion = readFileSync(runtimeTomlPath, 'utf-8')
    service.install()
    expect(readSystemToml()).toBe(systemTomlAfterPromotion)
    expect(readFileSync(runtimeTomlPath, 'utf-8')).toBe(runtimeTomlAfterPromotion)
  })

  it('never promotes trust for the Orca-managed status hook into ~/.codex', () => {
    writeSystemUserHook()
    const service = new CodexHookService()
    service.install()

    // Simulate Codex rewriting the managed Stop hook's trust entry (as an
    // approval after hash drift would).
    const runtimeHooksPath = join(runtimeHomeDir(), 'hooks.json')
    const managedCommand = (
      JSON.parse(readFileSync(runtimeHooksPath, 'utf-8')) as {
        hooks: { Stop: { hooks: { command: string }[] }[] }
      }
    ).hooks.Stop[0]!.hooks[0]!.command
    simulateCodexApproval(
      {
        sourcePath: runtimeHooksPath,
        eventLabel: 'stop',
        groupIndex: 0,
        handlerIndex: 0,
        command: managedCommand
      },
      { hash: 'sha256:codex-corrected-managed-hash' }
    )

    service.install()

    expect(readSystemToml()).not.toContain(managedCommand)
    expect(readSystemToml()).not.toContain('codex-corrected-managed-hash')
  })

  it('does not resurrect trust the user revoked in ~/.codex/config.toml', () => {
    writeSystemUserHook()
    // Pre-trust the hook in the system config, as a terminal Codex session would.
    const systemTomlPath = join(systemCodexDir(), 'config.toml')
    writeFileSync(systemTomlPath, upsertHookTrustEntriesInContent('', [systemUserStopEntry()]))

    const service = new CodexHookService()
    service.install()

    const runtimeTomlPath = join(runtimeHomeDir(), 'config.toml')
    const approvalKey = computeTrustKey(runtimeUserStopEntry())
    expect(readHookTrustEntries(runtimeTomlPath).get(approvalKey)).toBeDefined()

    // User revokes in the system config; the runtime copy must not win.
    writeFileSync(systemTomlPath, '')
    service.install()

    expect(readHookTrustEntries(runtimeTomlPath).get(approvalKey)).toBeUndefined()
    expect(readSystemToml()).not.toContain('[hooks.state.')
  })

  it('promotes an in-Orca disable of a mirrored user hook back to the system config', () => {
    writeSystemUserHook()
    const systemTomlPath = join(systemCodexDir(), 'config.toml')
    writeFileSync(systemTomlPath, upsertHookTrustEntriesInContent('', [systemUserStopEntry()]))

    const service = new CodexHookService()
    service.install()

    // User disables the hook via /hooks inside Orca-launched Codex.
    const runtimeTomlPath = join(runtimeHomeDir(), 'config.toml')
    const runtimeToml = readFileSync(runtimeTomlPath, 'utf-8')
    const approvalKey = computeTrustKey(runtimeUserStopEntry())
    expect(readHookTrustEntries(runtimeTomlPath).get(approvalKey)?.enabled).not.toBe(false)
    writeFileSync(
      runtimeTomlPath,
      upsertHookTrustEntriesInContent(runtimeToml, [{ ...runtimeUserStopEntry(), enabled: false }])
    )

    service.install()

    const systemState = readHookTrustEntries(systemTomlPath).get(
      computeTrustKey(systemUserStopEntry())
    )
    expect(systemState?.enabled).toBe(false)
    // The mirrored runtime entry reflects the disable on the next launch too.
    expect(readHookTrustEntries(runtimeTomlPath).get(approvalKey)?.enabled).toBe(false)
  })

  it('carries a Codex-written hash verbatim when it differs from the reproduced hash', () => {
    // Simulates Codex changing its trust hash algorithm: the approval hash in
    // the runtime config no longer matches computeTrustedHash's output.
    writeSystemUserHook()
    const service = new CodexHookService()
    service.install()

    const driftedHash = 'sha256:codex-next-gen-hash-orca-cannot-reproduce'
    simulateCodexApproval(runtimeUserStopEntry(), { hash: driftedHash })

    service.install()

    const runtimeTomlPath = join(runtimeHomeDir(), 'config.toml')
    const approvalKey = computeTrustKey(runtimeUserStopEntry())
    expect(readHookTrustEntries(runtimeTomlPath).get(approvalKey)?.trustedHash).toBe(driftedHash)
    expect(
      readHookTrustEntries(join(systemCodexDir(), 'config.toml')).get(
        computeTrustKey(systemUserStopEntry())
      )?.trustedHash
    ).toBe(driftedHash)

    // And the launch after that still keeps it.
    service.install()
    expect(readHookTrustEntries(runtimeTomlPath).get(approvalKey)?.trustedHash).toBe(driftedHash)
  })

  it('does not touch ~/.codex on the first launch after upgrading (no provenance yet)', () => {
    // Simulates an existing install: runtime home fully materialized by a
    // build without provenance snapshots, managed hooks only.
    const service = new CodexHookService()
    service.install()
    rmSync(join(runtimeHomeDir(), '.orca-hook-trust-provenance.json'), { force: true })

    service.install()

    expect(readSystemToml()).toBe('')
    expect(existsSync(join(systemCodexDir(), 'config.toml'))).toBe(false)
  })

  it('re-promoting mirrored trust without provenance is a no-op on ~/.codex', () => {
    // Existing install with a system-trusted user hook, upgraded to this
    // build: the mirrored runtime entry has no provenance, so promotion must
    // sit out this launch and leave the system config byte-identical.
    writeSystemUserHook()
    const systemTomlPath = join(systemCodexDir(), 'config.toml')
    writeFileSync(systemTomlPath, upsertHookTrustEntriesInContent('', [systemUserStopEntry()]))
    const service = new CodexHookService()
    service.install()
    rmSync(join(runtimeHomeDir(), '.orca-hook-trust-provenance.json'), { force: true })
    const systemTomlBefore = readSystemToml()

    service.install()

    expect(readSystemToml()).toBe(systemTomlBefore)
  })

  it('does not resurrect trust revoked in ~/.codex before the first provenance snapshot', () => {
    // Old build mirrored a system-trusted hook into the runtime home; the
    // user then revoked it in ~/.codex/config.toml and upgraded to this
    // build. The stale runtime mirror must not be mistaken for an approval.
    writeSystemUserHook()
    const systemTomlPath = join(systemCodexDir(), 'config.toml')
    writeFileSync(systemTomlPath, upsertHookTrustEntriesInContent('', [systemUserStopEntry()]))
    const service = new CodexHookService()
    service.install()
    rmSync(join(runtimeHomeDir(), '.orca-hook-trust-provenance.json'), { force: true })
    writeFileSync(systemTomlPath, '')

    service.install()

    expect(readSystemToml()).not.toContain('[hooks.state.')
    expect(
      readHookTrustEntries(join(runtimeHomeDir(), 'config.toml')).get(
        computeTrustKey(runtimeUserStopEntry())
      )
    ).toBeUndefined()
  })

  it('does not flip a hook the user disabled in ~/.codex back to enabled after upgrading', () => {
    // Old build mirrored the hook enabled=true; the user then set
    // enabled = false in ~/.codex/config.toml and upgraded to this build.
    writeSystemUserHook()
    const systemTomlPath = join(systemCodexDir(), 'config.toml')
    writeFileSync(systemTomlPath, upsertHookTrustEntriesInContent('', [systemUserStopEntry()]))
    const service = new CodexHookService()
    service.install()
    rmSync(join(runtimeHomeDir(), '.orca-hook-trust-provenance.json'), { force: true })
    writeFileSync(
      systemTomlPath,
      upsertHookTrustEntriesInContent('', [{ ...systemUserStopEntry(), enabled: false }])
    )

    service.install()

    expect(
      readHookTrustEntries(systemTomlPath).get(computeTrustKey(systemUserStopEntry()))?.enabled
    ).toBe(false)
    expect(
      readHookTrustEntries(join(runtimeHomeDir(), 'config.toml')).get(
        computeTrustKey(runtimeUserStopEntry())
      )?.enabled
    ).toBe(false)
  })

  it('promotes one approval to every identical system hook collapsed by deduping', () => {
    writeSystemUserHook([USER_HOOK_COMMAND, USER_HOOK_COMMAND])
    const service = new CodexHookService()
    service.install()

    simulateCodexApproval(runtimeUserStopEntry())
    service.install()

    const systemTrust = readHookTrustEntries(join(systemCodexDir(), 'config.toml'))
    const approvedHash = computeTrustedHash(runtimeUserStopEntry())
    expect(systemTrust.get(computeTrustKey(systemUserStopEntry(0)))?.trustedHash).toBe(approvedHash)
    expect(systemTrust.get(computeTrustKey(systemUserStopEntry(1)))?.trustedHash).toBe(approvedHash)
  })

  it('skips promotion when the approved hook no longer exists in ~/.codex/hooks.json', () => {
    writeSystemUserHook()
    const service = new CodexHookService()
    service.install()

    simulateCodexApproval(runtimeUserStopEntry())
    // User deletes the hook from their system hooks.json before relaunching.
    writeFileSync(join(systemCodexDir(), 'hooks.json'), JSON.stringify({ hooks: {} }))

    service.install()

    expect(readSystemToml()).not.toContain('[hooks.state.')
    // The runtime copy of the deleted hook (and its approval) is cleaned up.
    const runtimeTomlPath = join(runtimeHomeDir(), 'config.toml')
    expect(
      readHookTrustEntries(runtimeTomlPath).get(computeTrustKey(runtimeUserStopEntry()))
    ).toBeUndefined()
  })

  it('promotes approvals recorded while status hooks are disabled (refresh path)', () => {
    writeSystemUserHook()
    const service = new CodexHookService()
    service.refreshRuntimeUserHooks()

    // Without the managed status hook, the mirrored user hook sits at group 0.
    const refreshedRuntimeEntry: CodexTrustEntry = {
      ...runtimeUserStopEntry(),
      groupIndex: 0
    }
    simulateCodexApproval(refreshedRuntimeEntry)
    const approvedHash = computeTrustedHash(refreshedRuntimeEntry)

    service.refreshRuntimeUserHooks()

    expect(
      readHookTrustEntries(join(systemCodexDir(), 'config.toml')).get(
        computeTrustKey(systemUserStopEntry())
      )?.trustedHash
    ).toBe(approvedHash)
    expect(
      readHookTrustEntries(join(runtimeHomeDir(), 'config.toml')).get(
        computeTrustKey(refreshedRuntimeEntry)
      )?.trustedHash
    ).toBe(approvedHash)
  })
})
