import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { dirname, join } from 'node:path'
import type { HookDefinition } from '../agent-hooks/installer-utils'
import type { CodexHookTrustGrantRequest } from './codex-app-server-client'
import { CodexAppServerTimeoutError } from './codex-app-server-session'
import {
  CODEX_BACKGROUND_TRUST_GRANT_TIMEOUT_MS,
  _internals as grantInternals
} from './codex-hook-trust-grant'
import {
  computeTrustedHash,
  computeTrustKey,
  normalizeHookTrustKeyForLookup,
  parseTrustKey,
  readHookTrustEntries,
  upsertHookTrustEntries
} from './config-toml-trust'
import { isCodexManagedCommand, setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock, resolveCodexCommandMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>(),
  resolveCodexCommandMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: homedirMock }
})
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: resolveCodexCommandMock }))

import {
  _internals as realHomeInternals,
  ensureRealHomeCodexHookState,
  isRealHomeCodexHookLaneUsable,
  removeRealHomeCodexHookForOptOut,
  setRealHomeCodexHooksEnabledReader
} from './codex-real-home-hook-install'
import { cleanupLegacySystemManagedHooks } from './codex-hook-legacy-cleanup'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import { getCodexManagedHookInstallMaterial } from './codex-hook-definition'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'
import { readOrcaEntryTrust } from './codex-real-home-entry-trust'

// Why this file (QA case 4): a cold `codex app-server` on a loaded Mac took over
// 10 s. A launch must never wait on that approval, the approval must still land,
// and a failed one must not block the next try for minutes.

const homes = setupCodexHookHomes(homedirMock, getPathMock)
const USER_HOOK: HookDefinition = { hooks: [{ type: 'command', command: 'user-hook.sh' }] }

function hooksPath(): string {
  return join(homes.tmpHome, '.codex', 'hooks.json')
}

function configPath(): string {
  return join(homes.tmpHome, '.codex', 'config.toml')
}

function readHooks(): Record<string, HookDefinition[]> {
  const file: { hooks: Record<string, HookDefinition[]> } = JSON.parse(
    readFileSync(hooksPath(), 'utf-8')
  )
  return file.hooks
}

function orcaHandlerCount(): number {
  return Object.values(readHooks())
    .flat()
    .flatMap((definition) => definition.hooks ?? [])
    .filter((hook) => isCodexManagedCommand(hook.command)).length
}

function orcaEntryTrust(): string[] {
  const trust = readHookTrustEntries(configPath())
  return Object.entries(readHooks()).flatMap(([eventName, definitions]) =>
    definitions.flatMap((definition, groupIndex) =>
      (definition.hooks ?? []).flatMap((hook, handlerIndex) => {
        if (!isCodexManagedCommand(hook.command)) {
          return []
        }
        const entry = createCodexHookTrustEntry(
          hooksPath(),
          eventName,
          groupIndex,
          handlerIndex,
          definition,
          hook
        )
        return [entry ? readOrcaEntryTrust(entry, trust) : 'untrusted']
      })
    )
  )
}

/** The trust keys of the handlers in hooks.json that run `command`. */
function keysRunning(command: string): Set<string> {
  return new Set(
    Object.entries(readHooks()).flatMap(([eventName, definitions]) =>
      definitions.flatMap((definition, groupIndex) =>
        (definition.hooks ?? []).flatMap((hook, handlerIndex) => {
          const entry =
            hook.command === command
              ? createCodexHookTrustEntry(
                  hooksPath(),
                  eventName,
                  groupIndex,
                  handlerIndex,
                  definition,
                  hook
                )
              : null
          return entry ? [normalizeHookTrustKeyForLookup(computeTrustKey(entry))] : []
        })
      )
    )
  )
}

type AppServer = { sessions: number; start: () => void }

/**
 * An app-server whose start takes `coldStartMs`, ending when `start()` is called.
 * Past the session deadline it times out, as the real session does.
 */
function installAppServer(
  coldStartMs: number,
  failure?: Error,
  grant: typeof grantInternals = grantInternals
): AppServer {
  let start: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    start = resolve
  })
  const server: AppServer = { sessions: 0, start: () => start() }
  grant.setGrantSessionRunner(async (request: CodexHookTrustGrantRequest) => {
    server.sessions += 1
    await started
    if (coldStartMs > request.invocation.timeoutMs) {
      throw new CodexAppServerTimeoutError(
        `codex app-server session exceeded ${request.invocation.timeoutMs}ms`
      )
    }
    if (failure) {
      throw failure
    }
    // Why: Codex lists what hooks.json holds when it answers, not what the install wrote.
    const listed = keysRunning(request.managedCommand)
    if (
      !request.expectedTrustKeys.every((key) => listed.has(normalizeHookTrustKeyForLookup(key)))
    ) {
      return { outcome: 'verify-failed', reason: 'list mismatch', reasonClass: 'list-mismatch' }
    }
    const entries = request.expectedTrustKeys.map((key) => {
      const entry = { ...parseTrustKey(key)!, command: request.managedCommand, timeoutSec: 10 }
      return { key, entry, trustedHash: computeTrustedHash(entry) }
    })
    upsertHookTrustEntries(
      configPath(),
      entries.map(({ entry, trustedHash }) => ({ ...entry, trustedHash }))
    )
    return {
      outcome: 'granted' as const,
      wroteTrust: true,
      entries: entries.map(({ key, trustedHash }) => ({
        key,
        normalizedKey: normalizeHookTrustKeyForLookup(key),
        trustedHash
      }))
    }
  })
  return server
}

function launch(): ReturnType<typeof ensureRealHomeCodexHookState> {
  return ensureRealHomeCodexHookState({
    hooksEnabled: true,
    userDataPath: homes.userDataDir,
    writePolicy: 'add-missing-only'
  })
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  realHomeInternals.resetForTesting('pending')
  resolveCodexCommandMock.mockReturnValue(process.execPath)
  mkdirSync(join(homes.tmpHome, '.codex'), { recursive: true })
  writeFileSync(hooksPath(), `${JSON.stringify({ hooks: { Stop: [USER_HOOK] } }, null, 2)}\n`)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a slow codex app-server start', () => {
  it('never holds up a launch: a 15 s start grants in the background for the next launch', async () => {
    const server = installAppServer(15_000)

    const startedAt = performance.now()
    expect(await launch()).toBe('approving')
    expect(await launch()).toBe('approving')
    expect(performance.now() - startedAt).toBeLessThan(1_000)
    // Why: a launch that finds trust not ready uses the managed home.
    expect(isRealHomeCodexHookLaneUsable()).toBe(false)
    expect(orcaHandlerCount()).toBe(getCodexManagedHookInstallMaterial().events.length)

    server.start()
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('installed')

    expect(await launch()).toBe('installed')
    expect(isRealHomeCodexHookLaneUsable()).toBe(true)
    expect(server.sessions).toBe(1)
  })

  it('starts no cooldown after a timeout: the next launch tries again at once', async () => {
    const hung = installAppServer(10 * 60_000)
    hung.start()

    expect(await launch()).toBe('approving')
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('unavailable')
    // Why: the failed attempt takes back its own unapproved adds, so nothing asks for review.
    expect(orcaHandlerCount()).toBe(0)
    const events = getCodexManagedHookInstallMaterial().events.length
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`withdrew ${events} unapproved entries .*retrying on the next launch$`)
      )
    )

    const recovered = installAppServer(0)
    recovered.start()
    expect(await launch()).toBe('approving')
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('installed')
    expect(recovered.sessions).toBe(1)
  })

  it('backs off after three timeouts in a row, growing to 5 minutes, and a success resets it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let server = installAppServer(10 * 60_000)
    server.start()
    const timesOut = async (): Promise<void> => {
      expect(await launch()).toBe('approving')
      expect(await realHomeInternals.settledVerdictForTesting()).toBe('unavailable')
    }
    const waitsFor = async (ms: number): Promise<void> => {
      vi.setSystemTime(Date.now() + ms - 1)
      expect(await launch()).toBe('unavailable')
      vi.setSystemTime(Date.now() + 1)
    }

    await timesOut()
    await timesOut()
    await timesOut()
    for (const backoffMs of [10_000, 60_000, 300_000, 300_000]) {
      await waitsFor(backoffMs)
      await timesOut()
    }
    expect(server.sessions).toBe(7)

    server = installAppServer(0)
    server.start()
    await waitsFor(300_000)
    expect(await launch()).toBe('approving')
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('installed')

    // Why a ledger miss: it forces a fresh approval, which then times out again.
    rmSync(join(dirname(getOrcaManagedCodexHomePath()), 'trust-grant-ledger.json'))
    server = installAppServer(10 * 60_000)
    server.start()
    await timesOut()
    await timesOut()
    await timesOut()
    await waitsFor(10_000)
    await timesOut()
    expect(server.sessions).toBe(4)
  })

  it('keeps trying after timeouts during a slow first start, once the app server answers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const cold = installAppServer(10 * 60_000)
    cold.start()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await launch()).toBe('approving')
      expect(await realHomeInternals.settledVerdictForTesting()).toBe('unavailable')
    }

    const warm = installAppServer(0)
    warm.start()
    vi.setSystemTime(Date.now() + 10_000)
    expect(await launch()).toBe('approving')
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('installed')
    expect(warm.sessions).toBe(1)
  })

  it('runs one session at a time, ended by its own deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const spawnMs = 500
    let inFlight = 0
    let maxInFlight = 0
    grantInternals.setGrantSessionRunner(async (request: CodexHookTrustGrantRequest) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        // Why: the real session starts its kill timer once the app-server has spawned.
        await new Promise((resolve) => setTimeout(resolve, spawnMs))
        return await new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new CodexAppServerTimeoutError('codex app-server session timed out')),
            request.invocation.timeoutMs
          )
        )
      } finally {
        inFlight -= 1
      }
    })

    expect(await launch()).toBe('approving')
    await vi.advanceTimersByTimeAsync(CODEX_BACKGROUND_TRUST_GRANT_TIMEOUT_MS)
    // Why: the session is still alive, so a launch now must not start a second one.
    expect(await launch()).toBe('approving')
    await vi.advanceTimersByTimeAsync(spawnMs)
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('unavailable')
    expect(maxInFlight).toBe(1)
    expect(orcaHandlerCount()).toBe(0)
  })

  it('keeps already-trusted Orca entries trusted when a later re-grant fails', async () => {
    installAppServer(0).start()
    expect(await launch()).toBe('approving')
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('installed')
    const events = getCodexManagedHookInstallMaterial().events.length
    expect(orcaEntryTrust()).toEqual(Array(events).fill('trusted'))

    // Why a ledger miss: another Orca profile keeps its own ledger for this shared home.
    rmSync(join(dirname(getOrcaManagedCodexHomePath()), 'trust-grant-ledger.json'))
    realHomeInternals.resetForTesting('pending')
    const failing = installAppServer(
      0,
      new Error('codex app-server exited before completing the session')
    )
    failing.start()
    expect(await launch()).toBe('approving')
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('unavailable')

    expect(failing.sessions).toBe(1)
    expect(orcaEntryTrust()).toEqual(Array(events).fill('trusted'))
  })

  it('backs off for seconds, not minutes, after any other failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const failing = installAppServer(
      0,
      new Error('codex app-server exited before completing the session')
    )
    failing.start()

    expect(await launch()).toBe('approving')
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('unavailable')
    expect(await launch()).toBe('unavailable')
    expect(failing.sessions).toBe(1)

    vi.setSystemTime(Date.now() + 10_001)
    expect(await launch()).toBe('approving')
    await realHomeInternals.settledVerdictForTesting()
    expect(failing.sessions).toBe(2)
  })

  it('re-adds the entry after an approval that hooks off and on outlived has settled', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let hooksOn = true
    setRealHomeCodexHooksEnabledReader(() => hooksOn)
    const server = installAppServer(0)
    const events = getCodexManagedHookInstallMaterial().events.length
    expect(await launch()).toBe('approving')
    hooksOn = false
    expect(await removeRealHomeCodexHookForOptOut()).toBe('removed')
    expect(orcaHandlerCount()).toBe(0)
    // Why: a session is still live, whatever the opt-out concluded.
    expect(isRealHomeCodexHookLaneUsable()).toBe(false)

    hooksOn = true
    // Why: the running session still owns this attempt; re-adding now would start a second one.
    expect(await launch()).toBe('approving')
    expect(orcaHandlerCount()).toBe(0)
    expect(isRealHomeCodexHookLaneUsable()).toBe(false)

    server.start()
    // Why: Codex lists the hooks.json the opt-out emptied, so that session cannot approve.
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('unavailable')
    expect(server.sessions).toBe(1)
    vi.setSystemTime(Date.now() + 10_001)
    expect(await launch()).toBe('approving')
    expect(orcaHandlerCount()).toBe(events)
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('installed')
    expect(server.sessions).toBe(2)
    expect(orcaEntryTrust()).toEqual(Array(events).fill('trusted'))
  })

  it('keeps the lane unusable while hooks read off during an approval, and settles as removed', async () => {
    let hooksOn = true
    setRealHomeCodexHooksEnabledReader(() => hooksOn)
    const server = installAppServer(0)
    expect(await launch()).toBe('approving')

    // Why: the settings flipped, and the opt-out sweep has not run yet.
    hooksOn = false
    expect(
      await ensureRealHomeCodexHookState({
        hooksEnabled: false,
        userDataPath: homes.userDataDir,
        writePolicy: 'add-missing-only'
      })
    ).toBe('approving')
    expect(isRealHomeCodexHookLaneUsable()).toBe(false)

    server.start()
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('removed')
    expect(server.sessions).toBe(1)
  })

  it('keeps the lane unusable when an approval settles after an opt-out that failed', async () => {
    let hooksOn = true
    setRealHomeCodexHooksEnabledReader(() => hooksOn)
    const server = installAppServer(0)
    expect(await launch()).toBe('approving')

    hooksOn = false
    // Why: an opt-out that cannot parse hooks.json cannot prove the entry gone.
    writeFileSync(hooksPath(), '{ "hooks": ')
    expect(await removeRealHomeCodexHookForOptOut()).toBe('unavailable')

    server.start()
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('unavailable')
    expect(isRealHomeCodexHookLaneUsable()).toBe(false)
  })

  it('settles under the config.toml lane, after a writer that holds it', async () => {
    const failing = installAppServer(
      0,
      new Error('codex app-server exited before completing the session')
    )
    const events = getCodexManagedHookInstallMaterial().events.length
    expect(await launch()).toBe('approving')
    let release: () => void = () => {}
    const holder = runExclusivelyForCodexTrustConfig(
      configPath(),
      () => new Promise<void>((resolve) => (release = resolve))
    )

    failing.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(orcaHandlerCount()).toBe(events)
    release()
    await holder
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('unavailable')
    expect(orcaHandlerCount()).toBe(0)
  })

  it("stays on the managed home when hooks come back on inside a failed approval's retry window", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let hooksOn = true
    setRealHomeCodexHooksEnabledReader(() => hooksOn)
    const failing = installAppServer(
      0,
      new Error('codex app-server exited before completing the session')
    )
    expect(await launch()).toBe('approving')
    hooksOn = false
    failing.start()
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('removed')

    hooksOn = true
    expect(await launch()).toBe('unavailable')
    expect(isRealHomeCodexHookLaneUsable()).toBe(false)
    vi.setSystemTime(Date.now() + 10_001)
    expect(await launch()).toBe('approving')
    await realHomeInternals.settledVerdictForTesting()
  })

  // Why: app start's conversion is the first check, so none can meet an approval;
  // were one to, its settle must still write nothing a resume it releases could meet.
  it.skipIf(process.platform === 'win32')(
    'converts nothing during an approval, and its settle writes no new entry',
    async () => {
      const server = installAppServer(0)
      expect(await launch()).toBe('approving')
      // Why: an older build's pane launch added its own form beside Orca's entry meanwhile.
      const older = join(homes.tmpHome, '.orca', 'agent-hooks', 'codex-hook.sh')
      const hooks = readHooks()
      hooks.Stop = [...hooks.Stop, { hooks: [{ type: 'command', command: older, timeout: 10 }] }]
      writeFileSync(hooksPath(), `${JSON.stringify({ hooks }, null, 2)}\n`)
      const before = readFileSync(hooksPath(), 'utf-8')

      expect(
        await ensureRealHomeCodexHookState({
          hooksEnabled: true,
          userDataPath: homes.userDataDir,
          writePolicy: 'convert-older-forms'
        })
      ).toBe('approving')

      server.start()
      expect(await realHomeInternals.settledVerdictForTesting()).toBe('installed')
      expect(readFileSync(hooksPath(), 'utf-8')).toBe(before)
      expect(server.sessions).toBe(1)
    }
  )

  it('keeps the timeout streak through other failures', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const attempt = async (server: AppServer): Promise<void> => {
      server.start()
      expect(await launch()).toBe('approving')
      expect(await realHomeInternals.settledVerdictForTesting()).toBe('unavailable')
    }

    await attempt(installAppServer(10 * 60_000))
    await attempt(installAppServer(10 * 60_000))
    await attempt(
      installAppServer(0, new Error('codex app-server exited before completing the session'))
    )
    vi.setSystemTime(Date.now() + 10_001)
    // Why: the third timeout in a row, counting past the failure between them.
    await attempt(installAppServer(10 * 60_000))
    vi.setSystemTime(Date.now() + 9_999)
    expect(await launch()).toBe('unavailable')
    vi.setSystemTime(Date.now() + 1)
    expect(await launch()).toBe('approving')
    await realHomeInternals.settledVerdictForTesting()
  })

  it('starts the timeout streak from zero at app start', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      installAppServer(10 * 60_000).start()
      expect(await launch()).toBe('approving')
      expect(await realHomeInternals.settledVerdictForTesting()).toBe('unavailable')
    }
    expect(await launch()).toBe('unavailable')

    vi.resetModules()
    const restarted = await import('./codex-real-home-hook-install')
    const restartedGrant = await import('./codex-hook-trust-grant')
    installAppServer(10 * 60_000, undefined, restartedGrant._internals).start()
    const restartedLaunch = (): ReturnType<typeof ensureRealHomeCodexHookState> =>
      restarted.ensureRealHomeCodexHookState({
        hooksEnabled: true,
        userDataPath: homes.userDataDir,
        writePolicy: 'add-missing-only'
      })
    expect(await restartedLaunch()).toBe('approving')
    expect(await restarted._internals.settledVerdictForTesting()).toBe('unavailable')
    // Why: the first timeout since the restart retries on the next launch.
    expect(await restartedLaunch()).toBe('approving')
    await restarted._internals.settledVerdictForTesting()
  })

  it('has one retry schedule: turning hooks off and on after a failure retries at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const failing = installAppServer(
      0,
      new Error('codex app-server exited before completing the session')
    )
    failing.start()
    expect(await launch()).toBe('approving')
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('unavailable')

    await ensureRealHomeCodexHookState({
      hooksEnabled: false,
      userDataPath: homes.userDataDir,
      writePolicy: 'add-missing-only'
    })
    const recovered = installAppServer(0)
    recovered.start()
    expect(await launch()).toBe('approving')
    expect(await realHomeInternals.settledVerdictForTesting()).toBe('installed')
    expect(recovered.sessions).toBe(1)
  })

  it.skipIf(process.platform === 'win32')(
    'removes a retired entry and moves the user trust behind it with no Codex session',
    async () => {
      const hung = installAppServer(10 * 60_000)
      hung.start()
      const script = `'${join(homes.tmpHome, '.orca', 'agent-hooks', 'codex-hook.sh')}'`
      const retired = {
        hooks: [{ type: 'command', command: `if [ -x ${script} ]; then /bin/sh ${script}; fi` }]
      }
      writeFileSync(
        hooksPath(),
        `${JSON.stringify({ hooks: { Stop: [retired, USER_HOOK] } }, null, 2)}\n`
      )
      const userAt = (groupIndex: number) => ({
        sourcePath: hooksPath(),
        eventLabel: 'stop' as const,
        groupIndex,
        handlerIndex: 0,
        command: 'user-hook.sh'
      })
      upsertHookTrustEntries(configPath(), [{ ...userAt(1), trustedHash: 'sha256:user-approved' }])

      expect(await launch()).toBe('approving')
      expect(await realHomeInternals.settledVerdictForTesting()).toBe('unavailable')
      await cleanupLegacySystemManagedHooks()

      expect(readHooks().Stop).toEqual([USER_HOOK])
      const trust = readHookTrustEntries(configPath())
      expect(trust.get(computeTrustKey(userAt(0)))?.trustedHash).toBe('sha256:user-approved')
      // Why: the one session is the launch's grant; the removal started none.
      expect(hung.sessions).toBe(1)
    }
  )
})
