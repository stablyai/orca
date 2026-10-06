import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type * as InstallerUtils from '../agent-hooks/installer-utils'
import type * as TrustDerivation from './codex-hook-trust-derivation'
import { isCodexManagedCommand, setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock, hooks, codex } = vi.hoisted(() => {
  const hooks: { beforeHooksJsonWrite: (() => void) | null } = { beforeHooksJsonWrite: null }
  return {
    getPathMock: vi.fn<(name: string) => string>(),
    homedirMock: vi.fn<() => string>(),
    hooks,
    codex: {
      fingerprintCodex: vi.fn<(codexPath: string) => string | null>(),
      probeCodexVersion: vi.fn<(codexPath: string) => Promise<string | null>>(),
      deriveCodexHookHashes: vi.fn()
    }
  }
})

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: homedirMock
}))
// Why: stands in for the codex on PATH; each test says what it answers.
vi.mock('./codex-hook-trust-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof TrustDerivation>()),
  ...codex
}))
vi.mock('../agent-hooks/installer-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof InstallerUtils>()
  return {
    ...actual,
    writeHooksJson: (...args: Parameters<typeof actual.writeHooksJson>) => {
      hooks.beforeHooksJsonWrite?.()
      return actual.writeHooksJson(...args)
    }
  }
})

import { CodexHookService } from './hook-service'
import { _internals as lookupInternals, startCodexHookHashLookup } from './codex-hook-hash-lookup'
import { memoizeCodexHookAnswer } from './codex-hook-trust-memo'
import type { CodexHookAnswer } from './codex-hook-trust-derivation'
import {
  computeTrustKey,
  getCodexExplicitHomeHookSourcePath,
  computeTrustedHash,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexEventLabel
} from './config-toml-trust'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  computeOrcaCodexHookHashes,
  getManagedCommand,
  getManagedScriptPath
} from './codex-hook-definition'
import { CODEX_DAEMON_OVERRIDE_MARKER } from './codex-daemon-socket-path-guard'
import { writeCodexTrustGrantLedgerHome } from './codex-trust-grant-ledger'
import { getCodexHookTrustSignature } from './codex-hook-identity'

// Why this file: a managed CODEX_HOME's approval for Orca's entry is Codex's
// own hash, not one Orca computes, and is written before the entry.

const homes = setupCodexHookHomes(homedirMock, getPathMock)
// Why started: lets the lookup ask the stand-in Codex, as the app does.
beforeEach(() => {
  startCodexHookHashLookup({ pathReady: Promise.resolve(), isEnabled: () => false })
})

const CODEX_HASHES = {
  session_start: 'sha256:codex-session_start',
  user_prompt_submit: 'sha256:codex-user_prompt_submit',
  pre_tool_use: 'sha256:codex-pre_tool_use',
  permission_request: 'sha256:codex-permission_request',
  post_tool_use: 'sha256:codex-post_tool_use',
  stop: 'sha256:codex-stop'
}

function managedHome(): string {
  return join(homes.userDataDir, 'codex-runtime-home', 'home')
}

function managedKey(eventLabel: CodexEventLabel, groupIndex: number): string {
  return computeTrustKey({
    sourcePath: getCodexExplicitHomeHookSourcePath(join(managedHome(), 'hooks.json')),
    eventLabel,
    groupIndex,
    handlerIndex: 0,
    command: getManagedCommand(getManagedScriptPath())
  })
}

/** The approval at Orca's entry in each event Codex listed. */
function listedEventApprovals(): Record<string, string | undefined> {
  const trust = readHookTrustEntries(join(managedHome(), 'config.toml'))
  return Object.fromEntries(
    CODEX_EVENTS.map((eventName) => CODEX_EVENT_LABEL[eventName])
      .filter((label) => label in CODEX_HASHES)
      .map((label) => [label, trust.get(managedKey(label, 0))?.trustedHash])
  )
}

function seedSystemUserStopHook(): void {
  const systemHome = join(homes.tmpHome, '.codex')
  mkdirSync(systemHome, { recursive: true })
  writeFileSync(
    join(systemHome, 'hooks.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-stop.sh' }] }] } })
  )
  upsertHookTrustEntries(join(systemHome, 'config.toml'), [
    {
      sourcePath: join(systemHome, 'hooks.json'),
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'user-stop.sh'
    }
  ])
}

let codexBinaries = 0

/** From now on the codex on PATH is a new binary that gives `answer`, as after an update. */
function useAnswer(answer: CodexHookAnswer | Promise<CodexHookAnswer>): void {
  codexBinaries += 1
  codex.fingerprintCodex.mockReturnValue(`codex-${codexBinaries}`)
  codex.probeCodexVersion.mockResolvedValue(`codex-cli 0.${codexBinaries}.0`)
  codex.deriveCodexHookHashes.mockReturnValue(Promise.resolve(answer))
}

function useCodexHashes(): void {
  useAnswer({ kind: 'hashes', codexVersion: 'codex-cli 0.131.0', hashes: CODEX_HASHES })
}

const timedOut: CodexHookAnswer = { kind: 'pending', failure: 'timed out' }

const command = (): string => getManagedCommand(getManagedScriptPath())

describe('managed-home Codex hook approval', () => {
  it("approves Orca's entry with Codex's hash, enabled, only in the events Codex lists", async () => {
    seedSystemUserStopHook()
    useCodexHashes()

    expect((await new CodexHookService().install()).state).toBe('installed')

    const runtimeHooks = JSON.parse(readFileSync(join(managedHome(), 'hooks.json'), 'utf-8')).hooks
    expect(Object.keys(runtimeHooks).sort()).toEqual(
      [
        'PermissionRequest',
        'PostToolUse',
        'PreToolUse',
        'SessionStart',
        'Stop',
        'UserPromptSubmit'
      ].sort()
    )
    expect(isCodexManagedCommand(runtimeHooks.Stop[0].hooks[0].command)).toBe(true)
    expect(runtimeHooks.Stop[1].hooks[0].command).toBe('user-stop.sh')
    const trust = readHookTrustEntries(join(managedHome(), 'config.toml'))
    expect(trust.get(managedKey('stop', 0))).toEqual({
      trustedHash: 'sha256:codex-stop',
      enabled: true
    })
    expect(trust.get(managedKey('subagent_start', 0))).toBeUndefined()
    // Why: the mirrored user hook moved behind Orca's group, and its approval with it.
    expect(
      trust.get(
        computeTrustKey({
          sourcePath: getCodexExplicitHomeHookSourcePath(join(managedHome(), 'hooks.json')),
          eventLabel: 'stop',
          groupIndex: 1,
          handlerIndex: 0,
          command: 'user-stop.sh'
        })
      )?.trustedHash
    ).toBeDefined()
  })

  it('writes the approval before the entry, and takes it back if the entry write fails', async () => {
    useCodexHashes()
    const approvedAtWrite: (string | undefined)[] = []
    hooks.beforeHooksJsonWrite = () => {
      approvedAtWrite.push(
        readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('stop', 0))
          ?.trustedHash
      )
      throw new Error('disk full')
    }
    try {
      expect((await new CodexHookService().install()).state).toBe('error')
    } finally {
      hooks.beforeHooksJsonWrite = null
    }

    expect(approvedAtWrite).toEqual(['sha256:codex-stop'])
    expect(
      readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('stop', 0))
    ).toBe(undefined)
  })

  it("keeps only the user's hooks, and says to update Codex, when Codex has no hooks/list", async () => {
    seedSystemUserStopHook()
    useCodexHashes()
    const service = new CodexHookService()
    expect((await service.install()).state).toBe('installed')
    useAnswer({
      kind: 'refused',
      codexVersion: 'codex-cli 0.127.0',
      failure: 'Codex 0.127.0 is too old for Orca status; update Codex'
    })

    const status = await service.install()

    const runtimeHooks = JSON.parse(readFileSync(join(managedHome(), 'hooks.json'), 'utf-8')).hooks
    expect(runtimeHooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'user-stop.sh' }] }])
    // Why: the user's hook moved back to group 0, so only its own approval is at that key.
    expect(
      readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('stop', 0))
        ?.trustedHash
    ).not.toBe('sha256:codex-stop')
    expect(
      readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('session_start', 0))
    ).toBeUndefined()
    expect(status).toMatchObject({
      state: 'not_installed',
      detail: expect.stringContaining('update Codex')
    })
  })

  it('writes the entry with no approval in each listed event when Codex 0.128 has no approvals', async () => {
    seedSystemUserStopHook()
    useAnswer({
      kind: 'hashes',
      codexVersion: 'codex-cli 0.128.0',
      hashes: { stop: null, session_start: null }
    })

    expect((await new CodexHookService().install()).state).toBe('installed')

    const runtimeHooks = JSON.parse(readFileSync(join(managedHome(), 'hooks.json'), 'utf-8')).hooks
    expect(Object.keys(runtimeHooks).sort()).toEqual(['SessionStart', 'Stop'])
    expect(isCodexManagedCommand(runtimeHooks.Stop[0].hooks[0].command)).toBe(true)
    expect(runtimeHooks.Stop[1].hooks[0].command).toBe('user-stop.sh')
    expect(
      readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('stop', 0))
    ).toBeUndefined()
  })

  it("leaves a user hook's approval in place in an event Codex does not list Orca's entry for", async () => {
    const systemHome = join(homes.tmpHome, '.codex')
    mkdirSync(systemHome, { recursive: true })
    writeFileSync(
      join(systemHome, 'hooks.json'),
      JSON.stringify({
        hooks: { Interrupt: [{ hooks: [{ type: 'command', command: 'user-interrupt.sh' }] }] }
      })
    )
    const userInterrupt = {
      eventLabel: 'interrupt' as const,
      groupIndex: 0,
      handlerIndex: 0,
      command: 'user-interrupt.sh'
    }
    upsertHookTrustEntries(join(systemHome, 'config.toml'), [
      { ...userInterrupt, sourcePath: join(systemHome, 'hooks.json') }
    ])
    // Why: a Codex before 0.150 does not know Interrupt, so Orca's entry does not lead that event.
    useAnswer({ kind: 'hashes', codexVersion: 'codex-cli 0.149.0', hashes: CODEX_HASHES })

    expect((await new CodexHookService().install()).state).toBe('installed')

    const runtimeHooks = JSON.parse(readFileSync(join(managedHome(), 'hooks.json'), 'utf-8')).hooks
    expect(runtimeHooks.Interrupt).toEqual([
      { hooks: [{ type: 'command', command: 'user-interrupt.sh' }] }
    ])
    const sourcePath = getCodexExplicitHomeHookSourcePath(join(managedHome(), 'hooks.json'))
    expect(
      readHookTrustEntries(join(managedHome(), 'config.toml')).get(
        computeTrustKey({ ...userInterrupt, sourcePath })
      )?.trustedHash
    ).toBeDefined()
  })

  it("keeps a managed home's approved entry while Codex is not found", async () => {
    useCodexHashes()
    const service = new CodexHookService()
    expect((await service.install()).state).toBe('installed')
    // Why: before the shell PATH is hydrated, the codex a pane runs may not be found yet.
    codex.fingerprintCodex.mockReturnValue(null)

    const status = await service.install()

    expect(listedEventApprovals()).toEqual(CODEX_HASHES)
    expect(
      readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('stop', 0))
        ?.trustedHash
    ).toBe('sha256:codex-stop')
    expect(status).toMatchObject({
      state: 'installed',
      detail: expect.stringContaining('Approved by Orca; not yet confirmed by Codex')
    })
  })

  it("leaves user trust byte-untouched while approving Orca's entries", async () => {
    mkdirSync(managedHome(), { recursive: true })
    const userBlock = [
      '[hooks.state."/home/user/.codex/hooks.json:stop:3:1"]',
      'enabled = false',
      'trusted_hash = "sha256:user-owned-hash"'
    ].join('\n')
    writeFileSync(join(managedHome(), 'config.toml'), `${userBlock}\n`)
    useCodexHashes()

    expect((await new CodexHookService().install()).state).toBe('installed')
    expect(readFileSync(join(managedHome(), 'config.toml'), 'utf-8')).toContain(userBlock)
  })

  it("turning hooks off removes an approval from an older Codex version's hash", async () => {
    useCodexHashes()
    expect((await new CodexHookService().install()).state).toBe('installed')
    // Why: Codex updated since; the current binary's version hashes the entry differently.
    lookupInternals.resetForTesting()
    memoizeCodexHookAnswer(join(homes.userDataDir, 'codex'), 'codex-0.160', command(), {
      kind: 'hashes',
      codexVersion: 'codex-cli 0.160.0',
      hashes: { stop: 'sha256:codex-0.160-stop' }
    })

    await new CodexHookService().remove()

    const trust = readHookTrustEntries(join(managedHome(), 'config.toml'))
    expect(trust.get(managedKey('stop', 0))).toBeUndefined()
    expect(trust.get(managedKey('session_start', 0))).toBeUndefined()
  })

  it('reports why there is no status when Orca has not asked Codex yet', () => {
    lookupInternals.resetForTesting()

    expect(new CodexHookService().getStatus()).toMatchObject({
      state: 'not_installed',
      detail: 'Orca has not asked Codex yet'
    })
  })

  it("keeps a managed home's approved entry when Codex's answer comes after the launch's wait", async () => {
    useCodexHashes()
    const service = new CodexHookService()
    expect((await service.install()).state).toBe('installed')
    // Why: a Codex update makes the answer for the new binary slower than the launch may wait.
    useAnswer(
      new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({ kind: 'hashes', codexVersion: 'codex-cli 0.160.0', hashes: CODEX_HASHES }),
          200
        )
      })
    )

    await service.install(undefined, false)

    expect(listedEventApprovals()).toEqual(CODEX_HASHES)
    expect(
      readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('stop', 0))
    ).toEqual({ trustedHash: 'sha256:codex-stop', enabled: true })
  })

  it("keeps the managed config.toml loadable when hooks are off and the user's approvals are inline", async () => {
    const systemHome = join(homes.tmpHome, '.codex')
    mkdirSync(systemHome, { recursive: true })
    const userHook = { type: 'command', command: 'user-stop.sh' }
    writeFileSync(
      join(systemHome, 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [userHook] }] } })
    )
    const userKey = computeTrustKey({
      sourcePath: join(systemHome, 'hooks.json'),
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'user-stop.sh'
    })
    const userHash = computeTrustedHash({
      sourcePath: join(systemHome, 'hooks.json'),
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'user-stop.sh'
    })
    writeFileSync(
      join(systemHome, 'config.toml'),
      `model = "m"\n[hooks]\nstate = { ${JSON.stringify(userKey)} = { trusted_hash = "${userHash}" } }\n`
    )

    await new CodexHookService().refreshRuntimeUserHooks()

    expect(() => parseToml(readFileSync(join(managedHome(), 'config.toml'), 'utf-8'))).not.toThrow()
  })

  it("keeps a managed home's approved entry when Codex's answer timed out", async () => {
    useCodexHashes()
    const service = new CodexHookService()
    expect((await service.install()).state).toBe('installed')
    useAnswer({ kind: 'pending', failure: 'Codex app-server timed out' })

    await service.install()

    expect(listedEventApprovals()).toEqual(CODEX_HASHES)
    expect(
      readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('stop', 0))
        ?.trustedHash
    ).toBe('sha256:codex-stop')
  })

  it("keeps a managed home's approved entry when this process may not ask Codex, as in the CLI", async () => {
    useCodexHashes()
    const service = new CodexHookService()
    expect((await service.install()).state).toBe('installed')
    // Why: a new process that may not ask, and a codex it has no saved answer for.
    lookupInternals.resetForTesting()
    codex.fingerprintCodex.mockReturnValue('codex-unknown-to-the-cli')

    await service.install()

    expect(
      readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('stop', 0))
        ?.trustedHash
    ).toBe('sha256:codex-stop')
  })

  it("mirrors the user's Codex settings into a managed home on its first install", async () => {
    const systemHome = join(homes.tmpHome, '.codex')
    mkdirSync(systemHome, { recursive: true })
    writeFileSync(join(systemHome, 'config.toml'), 'model = "user-model"\n')
    useCodexHashes()

    expect((await new CodexHookService().install()).state).toBe('installed')

    expect(readFileSync(join(managedHome(), 'config.toml'), 'utf-8')).toContain(
      'model = "user-model"'
    )
  })

  it('applies the daemon socket guard to a long managed home on its first install', async () => {
    const longHome = join(homes.userDataDir, 'codex-accounts', 'a'.repeat(100), 'home')
    useCodexHashes()

    expect((await new CodexHookService().install(longHome)).state).toBe('installed')

    expect(readFileSync(join(longHome, 'config.toml'), 'utf-8')).toContain(
      CODEX_DAEMON_OVERRIDE_MARKER
    )
  })

  it("reports an approval that no longer holds Codex's hash, or that is switched off", async () => {
    useCodexHashes()
    const service = new CodexHookService()
    expect((await service.install()).state).toBe('installed')
    const stop = {
      sourcePath: getCodexExplicitHomeHookSourcePath(join(managedHome(), 'hooks.json')),
      groupIndex: 0,
      handlerIndex: 0,
      command: command()
    }
    upsertHookTrustEntries(join(managedHome(), 'config.toml'), [
      { ...stop, eventLabel: 'stop', trustedHash: 'sha256:stale' },
      {
        ...stop,
        eventLabel: 'session_start',
        trustedHash: CODEX_HASHES.session_start,
        enabled: false
      }
    ])

    expect(service.getStatus()).toMatchObject({
      state: 'partial',
      detail: 'Approval missing, stale or disabled for events: SessionStart, Stop'
    })
  })

  it("keeps Codex's answer when hooks are turned off, so turning them on asks nothing", async () => {
    useCodexHashes()
    const service = new CodexHookService()
    expect((await service.install()).state).toBe('installed')

    await service.remove()
    expect(service.getStatus()).toMatchObject({ state: 'not_installed', detail: null })
    expect((await service.install()).state).toBe('installed')

    expect(codex.deriveCodexHookHashes).toHaveBeenCalledTimes(1)
  })

  it("lets hooks turned off during a Codex launch's wait win", async () => {
    useCodexHashes()
    const service = new CodexHookService()
    await service.install()
    let enabled = true
    let answer: (value: CodexHookAnswer) => void = () => {}
    useAnswer(new Promise<CodexHookAnswer>((resolve) => (answer = resolve)))
    const launch = service.installForLaunchPrep(undefined, true, () => enabled)
    await vi.waitFor(() => expect(codex.deriveCodexHookHashes).toHaveBeenCalledTimes(2))

    enabled = false
    await service.remove()
    answer({ kind: 'hashes', codexVersion: 'codex-cli 0.131.0', hashes: CODEX_HASHES })
    await launch

    expect(readFileSync(join(managedHome(), 'hooks.json'), 'utf-8')).not.toContain('codex-hook')
    expect(listedEventApprovals().stop).toBeUndefined()
  })

  it("turning hooks off moves the user's mirrored approval back to its own slot", async () => {
    seedSystemUserStopHook()
    useCodexHashes()
    const service = new CodexHookService()
    await service.install()
    const userKey = (groupIndex: number): string =>
      computeTrustKey({
        sourcePath: getCodexExplicitHomeHookSourcePath(join(managedHome(), 'hooks.json')),
        eventLabel: 'stop',
        groupIndex,
        handlerIndex: 0,
        command: 'user-stop.sh'
      })
    const userHash = readHookTrustEntries(join(managedHome(), 'config.toml')).get(userKey(1))
    expect(userHash?.trustedHash).toBeDefined()

    await service.remove()

    const trust = readHookTrustEntries(join(managedHome(), 'config.toml'))
    expect(trust.get(userKey(0))?.trustedHash).toBe(userHash?.trustedHash)
    expect(trust.get(userKey(1))).toBeUndefined()
  })

  describe("Orca's own hash until Codex answers, as main wrote it", () => {
    const orcaStop = (): string | undefined => computeOrcaCodexHookHashes().stop ?? undefined

    function stopApproval(): string | undefined {
      return readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('stop', 0))
        ?.trustedHash
    }

    it("approves a fresh home with Orca's hash when Codex answers after the launch's wait", async () => {
      useAnswer(new Promise(() => {}))

      const status = await new CodexHookService().install(undefined, false)

      const runtimeHooks = JSON.parse(
        readFileSync(join(managedHome(), 'hooks.json'), 'utf-8')
      ).hooks
      expect(isCodexManagedCommand(runtimeHooks.Stop[0].hooks[0].command)).toBe(true)
      expect(
        readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('stop', 0))
      ).toEqual({
        trustedHash: orcaStop(),
        enabled: true
      })
      expect(status).toMatchObject({
        state: 'installed',
        detail: 'Approved by Orca; not yet confirmed by Codex (waiting for Codex to answer)'
      })
      expect(new CodexHookService().getStatus().detail).toBe(status.detail)
    })

    it("keeps the approval main's grant recorded for Orca's entry until Codex answers", async () => {
      useAnswer(timedOut)
      const service = new CodexHookService()
      await service.install()
      const entry = {
        sourcePath: getCodexExplicitHomeHookSourcePath(join(managedHome(), 'hooks.json')),
        eventLabel: 'stop' as const,
        groupIndex: 0,
        handlerIndex: 0,
        command: command(),
        timeoutSec: 10
      }
      upsertHookTrustEntries(join(managedHome(), 'config.toml'), [
        { ...entry, trustedHash: 'sha256:main-granted' }
      ])
      writeCodexTrustGrantLedgerHome(managedHome(), {
        binary: null,
        entries: {
          [computeTrustKey(entry)]: {
            signature: getCodexHookTrustSignature(entry),
            trustedHash: 'sha256:main-granted'
          }
        }
      })

      await service.install()

      expect(stopApproval()).toBe('sha256:main-granted')
      expect(service.getStatus().state).toBe('installed')
    })

    it("does not report a user hook's approval left at Orca's key as Orca's", async () => {
      useAnswer(timedOut)
      const service = new CodexHookService()
      await service.install()
      upsertHookTrustEntries(join(managedHome(), 'config.toml'), [
        {
          sourcePath: getCodexExplicitHomeHookSourcePath(join(managedHome(), 'hooks.json')),
          eventLabel: 'stop',
          groupIndex: 0,
          handlerIndex: 0,
          command: command(),
          trustedHash: 'sha256:user'
        }
      ])

      expect(service.getStatus()).toMatchObject({
        state: 'partial',
        detail: "Orca's hook entry is not approved yet (timed out)"
      })
    })

    it("approves a fresh home with Orca's hash while Codex is not found", async () => {
      codex.fingerprintCodex.mockReturnValue(null)

      expect((await new CodexHookService().install()).state).toBe('installed')

      expect(stopApproval()).toBe(orcaStop())
    })

    it('reports an entry left without any approval while Codex has not answered', async () => {
      useAnswer(timedOut)
      const service = new CodexHookService()
      await service.install()
      writeFileSync(join(managedHome(), 'config.toml'), '')

      expect(service.getStatus()).toMatchObject({
        state: 'partial',
        detail: "Orca's hook entry is not approved yet (timed out)"
      })
    })

    it("keeps each event's approval and gives Orca's hash to the rest until Codex answers", async () => {
      useAnswer({
        kind: 'hashes',
        codexVersion: 'codex-cli 0.131.0',
        hashes: { stop: CODEX_HASHES.stop }
      })
      const service = new CodexHookService()
      await service.install()
      useAnswer(timedOut)

      await service.install()

      const runtimeHooks = JSON.parse(
        readFileSync(join(managedHome(), 'hooks.json'), 'utf-8')
      ).hooks
      expect(isCodexManagedCommand(runtimeHooks.SessionStart[0].hooks[0].command)).toBe(true)
      const trust = readHookTrustEntries(join(managedHome(), 'config.toml'))
      expect(trust.get(managedKey('stop', 0))?.trustedHash).toBe('sha256:codex-stop')
      expect(trust.get(managedKey('session_start', 0))?.trustedHash).toBe(
        computeOrcaCodexHookHashes().session_start
      )
    })

    it("replaces a user hook's approval left at Orca's key with Orca's hash", async () => {
      useAnswer(timedOut)
      const service = new CodexHookService()
      await service.install()
      // Why: keys are positional; removing a user hook ahead of Orca's leaves its approval here.
      upsertHookTrustEntries(join(managedHome(), 'config.toml'), [
        {
          sourcePath: getCodexExplicitHomeHookSourcePath(join(managedHome(), 'hooks.json')),
          eventLabel: 'stop',
          groupIndex: 0,
          handlerIndex: 0,
          command: command(),
          trustedHash: 'sha256:user'
        }
      ])

      await service.install()

      expect(stopApproval()).toBe(orcaStop())
    })

    it("replaces Orca's hash with Codex's once Codex answers", async () => {
      useAnswer(timedOut)
      const service = new CodexHookService()
      await service.install()
      expect(stopApproval()).toBe(orcaStop())

      useCodexHashes()
      expect((await service.install()).state).toBe('installed')

      expect(stopApproval()).toBe('sha256:codex-stop')
    })

    it('uses no fallback when Codex answered that it has no hooks/list', async () => {
      useAnswer({
        kind: 'refused',
        codexVersion: 'codex-cli 0.127.0',
        failure: 'Codex 0.127.0 is too old for Orca status; update Codex'
      })

      const status = await new CodexHookService().install()

      expect(stopApproval()).toBeUndefined()
      expect(readFileSync(join(managedHome(), 'hooks.json'), 'utf-8')).not.toContain('codex-hook')
      expect(status).toMatchObject({
        state: 'not_installed',
        detail: expect.stringContaining('update Codex')
      })
    })

    it("approves with Orca's hash in a process that may not ask Codex, as the offline CLI is", async () => {
      // Why reset: no resolver stub and no permission to ask, as in the CLI's process.
      lookupInternals.resetForTesting()

      expect((await new CodexHookService().install()).state).toBe('installed')

      expect(stopApproval()).toBe(orcaStop())
    })
  })
})
