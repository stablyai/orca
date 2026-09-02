import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CodexAppServerUnsupportedError,
  type CodexHookTrustGrantRequest,
  type CodexHookTrustGrantSessionResult
} from './codex-app-server-client'
import { codexAppServerCapabilityCache } from './codex-app-server-capability-cache'
import {
  _internals,
  CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS,
  getCodexTrustGrantDiagnostics,
  grantManagedCodexHookTrust,
  type CodexManagedTrustGrantPlan
} from './codex-hook-trust-grant'
import { setCodexTrustGrantTelemetry } from './codex-trust-grant-telemetry'
import { readCodexTrustGrantLedgerHome } from './codex-trust-grant-ledger'
import {
  computeTrustKey,
  computeTrustedHash,
  normalizeHookTrustKeyForLookup,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'

let userDataDir: string
let runtimeHomeDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-trust-grant-userdata-'))
  runtimeHomeDir = join(userDataDir, 'codex-runtime-home', 'home')
  // Why: production writes hooks.json before granting trust; keeping that
  // ordering prevents test-only canonical-path drift during ledger setup.
  mkdirSync(runtimeHomeDir, { recursive: true })
  writeFileSync(join(runtimeHomeDir, 'hooks.json'), '{"hooks":{}}\n', 'utf-8')
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  codexAppServerCapabilityCache.clear()
  _internals.resetDiagnostics()
})

afterEach(() => {
  vi.useRealTimers()
  _internals.setGrantSessionRunner(null)
  setCodexTrustGrantTelemetry(() => {})
  codexAppServerCapabilityCache.clear()
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  delete process.env.ORCA_DISABLE_CODEX_TRUST_RPC
  rmSync(userDataDir, { recursive: true, force: true })
})

const MANAGED_COMMAND = "/bin/sh '/tmp/orca/codex-hook.sh'"

function managedEntry(eventLabel: CodexTrustEntry['eventLabel']): CodexTrustEntry {
  return {
    sourcePath: join(runtimeHomeDir, 'hooks.json'),
    eventLabel,
    groupIndex: 0,
    handlerIndex: 0,
    command: MANAGED_COMMAND,
    timeoutSec: 10
  }
}

function buildPlan(entries: CodexTrustEntry[]): CodexManagedTrustGrantPlan {
  return {
    runtimeHomePath: runtimeHomeDir,
    tomlPath: join(runtimeHomeDir, 'config.toml'),
    managedCommand: MANAGED_COMMAND,
    managedEntries: entries,
    host: { kind: 'native' },
    telemetryLane: 'real-home'
  }
}

function grantedSessionResult(entries: CodexTrustEntry[], hashPrefix = 'sha256:codex-') {
  return {
    outcome: 'granted' as const,
    wroteTrust: true,
    entries: entries.map((entry) => {
      const key = computeTrustKey(entry)
      return {
        key,
        normalizedKey: normalizeHookTrustKeyForLookup(key),
        trustedHash: `${hashPrefix}${entry.eventLabel}`
      }
    })
  }
}

describe('grantManagedCodexHookTrust', () => {
  it('does not let a short trust RPC claim an incomplete session index', async () => {
    const sessions = join(runtimeHomeDir, 'sessions')
    mkdirSync(sessions, { recursive: true })
    for (let index = 0; index < 100; index += 1) {
      writeFileSync(join(sessions, `${index}.jsonl`), '{}\n')
    }
    const runner = vi.fn()
    _internals.setGrantSessionRunner(runner)

    expect(await grantManagedCodexHookTrust(buildPlan([managedEntry('stop')]))).toMatchObject({
      lane: 'fallback',
      reason: 'retry-cached'
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('returns granted entries with codex-verbatim hashes and records the ledger', async () => {
    const entries = [managedEntry('session_start'), managedEntry('stop')]
    const runner = vi.fn(async (_request: CodexHookTrustGrantRequest) =>
      grantedSessionResult(entries)
    )
    _internals.setGrantSessionRunner(runner)

    const outcome = await grantManagedCodexHookTrust(buildPlan(entries))
    expect(outcome.lane).toBe('rpc')
    if (outcome.lane !== 'rpc') {
      return
    }
    expect(outcome.entries.map((entry) => entry.trustedHash)).toEqual([
      'sha256:codex-session_start',
      'sha256:codex-stop'
    ])
    expect(runner).toHaveBeenCalledTimes(1)
    const request = runner.mock.calls[0]![0]!
    expect(request.managedCommand).toBe(MANAGED_COMMAND)
    expect(request.expectedTrustKeys).toHaveLength(2)
    expect(request.invocation.env?.CODEX_HOME).toBe(runtimeHomeDir)

    const ledgerHome = readCodexTrustGrantLedgerHome(runtimeHomeDir)
    expect(ledgerHome).not.toBeNull()
    expect(Object.keys(ledgerHome!.entries)).toHaveLength(2)
    expect(getCodexTrustGrantDiagnostics()).toMatchObject({ granted: 1, fellBack: 0 })
  })

  it('builds a default-home grant invocation without an inherited CODEX_HOME', async () => {
    const entries = [managedEntry('stop')]
    const runner = vi.fn(async (_request: CodexHookTrustGrantRequest) =>
      grantedSessionResult(entries)
    )
    _internals.setGrantSessionRunner(runner)

    expect(
      await grantManagedCodexHookTrust({ ...buildPlan(entries), useDefaultCodexHome: true })
    ).toMatchObject({ lane: 'rpc' })
    const invocation = runner.mock.calls[0]![0]!.invocation
    expect(invocation.env?.CODEX_HOME).toBeUndefined()
    expect(invocation.envToDelete).toContain('CODEX_HOME')
  })

  it('removes equivalent Windows fallback keys before the RPC writes canonical trust', async () => {
    const entry: CodexTrustEntry = {
      ...managedEntry('stop'),
      sourcePath: String.raw`C:\Users\Alice\.codex\hooks.json`
    }
    const plan = buildPlan([entry])
    upsertHookTrustEntries(plan.tomlPath, [entry])
    expect(readHookTrustEntries(plan.tomlPath).get(computeTrustKey(entry))?.trustedHash).toBe(
      computeTrustedHash(entry)
    )
    const runner = vi.fn(async () => {
      expect(readHookTrustEntries(plan.tomlPath).has(computeTrustKey(entry))).toBe(false)
      return grantedSessionResult([entry])
    })
    _internals.setGrantSessionRunner(runner)

    expect(await grantManagedCodexHookTrust(plan)).toMatchObject({ lane: 'rpc' })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('skips the RPC session while the ledger grant still holds, and re-grants on config drift', async () => {
    const entries = [managedEntry('session_start')]
    const runner = vi.fn(async () => grantedSessionResult(entries))
    _internals.setGrantSessionRunner(runner)
    const plan = buildPlan(entries)

    const first = await grantManagedCodexHookTrust(plan)
    expect(first.lane).toBe('rpc')
    expect(runner).toHaveBeenCalledTimes(1)

    // Why: the ledger skip only holds while config.toml still carries the
    // granted hash at the granted key — write it the way codex left it.
    upsertHookTrustEntries(plan.tomlPath, [
      { ...entries[0], trustedHash: 'sha256:codex-session_start' }
    ])
    const second = await grantManagedCodexHookTrust(plan)
    expect(second.lane).toBe('rpc')
    expect(runner).toHaveBeenCalledTimes(1)
    expect(getCodexTrustGrantDiagnostics()).toMatchObject({ granted: 1, ledgerHits: 1 })

    // Config drift (user wiped the trust entry) must re-run the session.
    upsertHookTrustEntries(plan.tomlPath, [{ ...entries[0], trustedHash: 'sha256:wiped' }])
    const third = await grantManagedCodexHookTrust(plan)
    expect(third.lane).toBe('rpc')
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('re-grants when the managed hook identity changes', async () => {
    const entries = [managedEntry('session_start')]
    const runner = vi.fn(async () => grantedSessionResult(entries))
    _internals.setGrantSessionRunner(runner)
    const plan = buildPlan(entries)
    await grantManagedCodexHookTrust(plan)
    upsertHookTrustEntries(plan.tomlPath, [
      { ...entries[0], trustedHash: 'sha256:codex-session_start' }
    ])

    const changedEntries = [{ ...entries[0], timeoutSec: 99 }]
    const changedRunner = vi.fn(async () => grantedSessionResult(changedEntries))
    _internals.setGrantSessionRunner(changedRunner)
    const outcome = await grantManagedCodexHookTrust(buildPlan(changedEntries))
    expect(outcome.lane).toBe('rpc')
    expect(changedRunner).toHaveBeenCalledTimes(1)
  })

  it('marks the host unsupported only for the unsupported error class', async () => {
    const entries = [managedEntry('session_start')]
    const runner = vi.fn((): Promise<CodexHookTrustGrantSessionResult> => {
      throw new CodexAppServerUnsupportedError('no such method')
    })
    _internals.setGrantSessionRunner(runner)
    const plan = buildPlan(entries)

    expect(await grantManagedCodexHookTrust(plan)).toMatchObject({
      lane: 'fallback',
      reason: 'unsupported'
    })
    expect(runner).toHaveBeenCalledTimes(1)

    // Cached: the second install skips the probe entirely.
    expect(await grantManagedCodexHookTrust(plan)).toMatchObject({
      lane: 'fallback',
      reason: 'unsupported-cached'
    })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('backs off transient failures without poisoning the capability', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const entries = [managedEntry('session_start')]
    const runner = vi.fn((): Promise<CodexHookTrustGrantSessionResult> => {
      throw new Error('spawn ETIMEDOUT')
    })
    _internals.setGrantSessionRunner(runner)
    const plan = buildPlan(entries)

    expect(await grantManagedCodexHookTrust(plan)).toMatchObject({
      lane: 'fallback',
      reason: 'error'
    })
    expect(await grantManagedCodexHookTrust(plan)).toMatchObject({
      lane: 'fallback',
      reason: 'retry-cached'
    })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(codexAppServerCapabilityCache.shouldTry('native')).toBe(true)

    runner.mockImplementation(async () => grantedSessionResult(entries))
    vi.setSystemTime(1_000 + CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS)
    expect(await grantManagedCodexHookTrust(plan)).toMatchObject({ lane: 'rpc' })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('falls back on verify-failed without marking unsupported', async () => {
    const entries = [managedEntry('session_start')]
    const runner = vi.fn(async () => ({
      outcome: 'verify-failed' as const,
      reason: 'missing entries',
      reasonClass: 'list-mismatch' as const
    }))
    _internals.setGrantSessionRunner(runner)

    expect(await grantManagedCodexHookTrust(buildPlan(entries))).toMatchObject({
      lane: 'fallback',
      reason: 'verify-failed'
    })
    expect(codexAppServerCapabilityCache.shouldTry('native')).toBe(true)
    expect(getCodexTrustGrantDiagnostics()).toMatchObject({ verifyFailed: 1 })
  })

  it('rejects duplicate granted keys instead of treating another key as covered', async () => {
    const entries = [managedEntry('session_start'), managedEntry('stop')]
    const duplicated = grantedSessionResult([entries[0]!, entries[0]!])
    _internals.setGrantSessionRunner(async () => duplicated)

    expect(await grantManagedCodexHookTrust(buildPlan(entries))).toMatchObject({
      lane: 'fallback',
      reason: 'verify-failed'
    })
    expect(readCodexTrustGrantLedgerHome(runtimeHomeDir)).toBeNull()
  })

  it('keeps grant and fallback outcomes stable when telemetry throws', async () => {
    const entries = [managedEntry('session_start')]
    setCodexTrustGrantTelemetry(() => {
      throw new Error('telemetry unavailable')
    })
    _internals.setGrantSessionRunner(async () => grantedSessionResult(entries))

    expect(await grantManagedCodexHookTrust(buildPlan(entries))).toMatchObject({ lane: 'rpc' })
    process.env.ORCA_DISABLE_CODEX_TRUST_RPC = '1'
    expect(await grantManagedCodexHookTrust(buildPlan(entries))).toMatchObject({
      lane: 'fallback',
      reason: 'disabled'
    })
  })

  it('restores exact config bytes before fallback after a mutating RPC error', async () => {
    const entries = [managedEntry('session_start')]
    const plan = buildPlan(entries)
    const original = '# user formatting\r\n[hooks]\r\n'
    mkdirSync(runtimeHomeDir, { recursive: true })
    writeFileSync(plan.tomlPath, original)
    _internals.setGrantSessionRunner(async () => {
      writeFileSync(plan.tomlPath, '[hooks.state."rpc-partial"]\ntrusted_hash = "changed"\n')
      throw new Error('post-write transport failure')
    })

    expect(await grantManagedCodexHookTrust(plan)).toMatchObject({
      lane: 'fallback',
      reason: 'error'
    })
    expect(readFileSync(plan.tomlPath, 'utf8')).toBe(original)
  })

  it('removes an RPC-created config before fallback when none existed', async () => {
    const entries = [managedEntry('session_start')]
    const plan = buildPlan(entries)
    mkdirSync(runtimeHomeDir, { recursive: true })
    _internals.setGrantSessionRunner(async () => {
      writeFileSync(plan.tomlPath, '[hooks.state."rpc-partial"]\ntrusted_hash = "changed"\n')
      return {
        outcome: 'verify-failed',
        reason: 'post-write listing failed',
        reasonClass: 'post-grant-mismatch'
      }
    })

    expect(await grantManagedCodexHookTrust(plan)).toMatchObject({
      lane: 'fallback',
      reason: 'verify-failed'
    })
    expect(existsSync(plan.tomlPath)).toBe(false)
  })

  it('honors the ops kill switch env flag', async () => {
    process.env.ORCA_DISABLE_CODEX_TRUST_RPC = '1'
    const entries = [managedEntry('session_start')]
    const runner = vi.fn(async () => grantedSessionResult(entries))
    _internals.setGrantSessionRunner(runner)

    expect(await grantManagedCodexHookTrust(buildPlan(entries))).toMatchObject({
      lane: 'fallback',
      reason: 'disabled'
    })
    expect(runner).not.toHaveBeenCalled()
  })

  // Why (#16441): the grant used to run through spawnSync, so two grants on one
  // config.toml were impossible by construction. Now they must queue — an
  // interleaved capture/restore pair resurrects trust the other run removed.
  it('serializes concurrent grants that share one config.toml', async () => {
    const entries = [managedEntry('session_start')]
    const plan = buildPlan(entries)
    let inFlight = 0
    let maxInFlight = 0
    const releases: (() => void)[] = []
    _internals.setGrantSessionRunner(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise<void>((resolve) => releases.push(resolve))
      inFlight -= 1
      return grantedSessionResult(entries)
    })

    const first = grantManagedCodexHookTrust(plan)
    const second = grantManagedCodexHookTrust(plan)
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    releases[0]!()
    await first
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[1]!()
    await second

    expect(maxInFlight).toBe(1)
  })

  it('lets grants on different config.toml paths overlap', async () => {
    const entries = [managedEntry('session_start')]
    const otherHome = join(userDataDir, 'codex-accounts', 'other', 'home')
    mkdirSync(otherHome, { recursive: true })
    // Why: the probe dedupe only holds the first session on an unproven host.
    // A known-supported host must keep its intended launch concurrency.
    codexAppServerCapabilityCache.rememberSupported('native')
    let inFlight = 0
    let maxInFlight = 0
    const releases: (() => void)[] = []
    _internals.setGrantSessionRunner(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise<void>((resolve) => releases.push(resolve))
      inFlight -= 1
      return grantedSessionResult(entries)
    })

    const first = grantManagedCodexHookTrust(buildPlan(entries))
    const second = grantManagedCodexHookTrust({
      ...buildPlan(entries),
      runtimeHomePath: otherHome,
      tomlPath: join(otherHome, 'config.toml')
    })
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases.forEach((release) => release())
    await Promise.all([first, second])

    expect(maxInFlight).toBe(2)
  })

  it('dedupes the capability probe when concurrent grants hit an unsupported host', async () => {
    const entries = [managedEntry('session_start')]
    const otherHome = join(userDataDir, 'codex-accounts', 'other', 'home')
    mkdirSync(otherHome, { recursive: true })
    const releases: ((error: unknown) => void)[] = []
    const runner = vi.fn(() => new Promise<never>((_resolve, reject) => releases.push(reject)))
    _internals.setGrantSessionRunner(runner)

    const first = grantManagedCodexHookTrust(buildPlan(entries))
    const second = grantManagedCodexHookTrust({
      ...buildPlan(entries),
      runtimeHomePath: otherHome,
      tomlPath: join(otherHome, 'config.toml')
    })
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    releases[0]!(new CodexAppServerUnsupportedError('no such method'))

    expect(await first).toMatchObject({ lane: 'fallback', reason: 'unsupported' })
    expect(await second).toMatchObject({ lane: 'fallback', reason: 'unsupported-cached' })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('builds a WSL invocation that runs codex inside the distro', async () => {
    const entries = [managedEntry('session_start')]
    const runner = vi.fn(async (_request: CodexHookTrustGrantRequest) =>
      grantedSessionResult(entries)
    )
    _internals.setGrantSessionRunner(runner)

    const outcome = await grantManagedCodexHookTrust({
      ...buildPlan(entries),
      host: { kind: 'wsl', distro: 'Ubuntu', linuxRuntimeHome: '/home/alice/.codex-runtime' }
    })
    expect(outcome.lane).toBe('rpc')
    const request = runner.mock.calls[0]![0]!
    expect(request.invocation.command).toBe('wsl.exe')
    expect(request.invocation.args.slice(0, 2)).toEqual(['-d', 'Ubuntu'])
    expect(request.invocation.args.join(' ')).toContain('app-server')
    expect(request.hooksListCwd).toBe('/home/alice/.codex-runtime')
  })
})

describe('trust-grant telemetry detail', () => {
  type CapturedEvent = Record<string, unknown>

  function captureTelemetry(): CapturedEvent[] {
    const events: CapturedEvent[] = []
    setCodexTrustGrantTelemetry((event) => {
      events.push(event)
    })
    return events
  }

  it('attributes the plan lane on granted events', async () => {
    const events = captureTelemetry()
    const entries = [managedEntry('session_start')]
    _internals.setGrantSessionRunner(async () => grantedSessionResult(entries))

    expect(await grantManagedCodexHookTrust(buildPlan(entries))).toMatchObject({ lane: 'rpc' })
    expect(events).toEqual([{ outcome: 'granted', hostKind: 'native', lane: 'real-home' }])
  })

  it('reports the managed lane independently of host kind', async () => {
    const events = captureTelemetry()
    const entries = [managedEntry('session_start')]
    _internals.setGrantSessionRunner(async () => grantedSessionResult(entries))

    await grantManagedCodexHookTrust({ ...buildPlan(entries), telemetryLane: 'managed' })
    expect(events).toEqual([{ outcome: 'granted', hostKind: 'native', lane: 'managed' }])
  })

  it('classifies error fallbacks on the wire', async () => {
    const events = captureTelemetry()
    const entries = [managedEntry('session_start')]
    _internals.setGrantSessionRunner(async () => {
      throw new Error('spawn codex ENOENT')
    })

    expect(await grantManagedCodexHookTrust(buildPlan(entries))).toMatchObject({
      lane: 'fallback',
      reason: 'error'
    })
    expect(events).toEqual([
      {
        outcome: 'fallback',
        hostKind: 'native',
        lane: 'real-home',
        reason: 'error',
        errorClass: 'binary-missing'
      }
    ])
  })

  it('carries the session verify class through the fallback event', async () => {
    const events = captureTelemetry()
    const entries = [managedEntry('session_start')]
    _internals.setGrantSessionRunner(async () => ({
      outcome: 'verify-failed' as const,
      reason: 'post-grant verify left 1 entries untrusted',
      reasonClass: 'post-grant-untrusted' as const
    }))

    await grantManagedCodexHookTrust(buildPlan(entries))
    expect(events).toEqual([
      {
        outcome: 'verify_failed',
        hostKind: 'native',
        lane: 'real-home',
        reason: 'verify-failed',
        verifyClass: 'post-grant-untrusted'
      }
    ])
  })

  it('classifies module-detected verify failures', async () => {
    const events = captureTelemetry()
    const entries = [managedEntry('session_start'), managedEntry('stop')]
    _internals.setGrantSessionRunner(async () => grantedSessionResult([entries[0]!, entries[0]!]))

    await grantManagedCodexHookTrust(buildPlan(entries))
    expect(events).toEqual([
      {
        outcome: 'verify_failed',
        hostKind: 'native',
        lane: 'real-home',
        reason: 'verify-failed',
        verifyClass: 'duplicate-key'
      }
    ])
  })
})
