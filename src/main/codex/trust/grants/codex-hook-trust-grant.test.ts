import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexAppServerCapabilityCache } from '../../app-server/codex-app-server-capability-cache'
import {
  _internals,
  getCodexTrustGrantDiagnostics,
  grantManagedCodexHookTrust
} from './codex-hook-trust-grant'
import type { CodexManagedTrustGrantPlan } from './codex-managed-trust-grant-plan'
import { removeSelfComputedTrustBeforeGrant } from './codex-managed-trust-grant-plan'
import { setCodexTrustGrantTelemetry } from './codex-trust-grant-telemetry'
import { readCodexTrustGrantLedgerHome } from './codex-trust-grant-ledger'
import {
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from '../toml/config-toml-trust'
import {
  computeCodexTrustKey as computeTrustKey,
  computeCodexTrustedHash as computeTrustedHash,
  normalizeCodexHookTrustLookupKey as normalizeHookTrustKeyForLookup
} from '../identity/codex-trust-identity'

// Unavailable wsl.exe leaves guest grants unstamped.
vi.mock('@orca/process-host', () => ({
  runProcess: vi.fn(async () => ({
    code: 1,
    signal: null,
    timedOut: false,
    stdout: '',
    stderr: ''
  }))
}))

let userDataDir: string
let runtimeHomeDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-trust-grant-userdata-'))
  runtimeHomeDir = join(userDataDir, 'codex-runtime-home', 'home')
  // Create hooks.json before granting trust to match production canonical-path resolution.
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

function buildPlan(
  entries: CodexTrustEntry[],
  host: CodexManagedTrustGrantPlan['host'] = {
    kind: 'wsl',
    distro: 'Ubuntu',
    linuxRuntimeHome: runtimeHomeDir
  }
): CodexManagedTrustGrantPlan {
  return {
    runtimeHomePath: runtimeHomeDir,
    tomlPath: join(runtimeHomeDir, 'config.toml'),
    managedCommand: MANAGED_COMMAND,
    managedEntries: entries,
    host
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

  it('treats an unreadable session index as pending instead of running a trust RPC', async () => {
    writeFileSync(join(runtimeHomeDir, 'state_5.sqlite'), 'not a sqlite database')
    const runner = vi.fn()
    _internals.setGrantSessionRunner(runner)

    expect(await grantManagedCodexHookTrust(buildPlan([managedEntry('stop')]))).toMatchObject({
      lane: 'fallback',
      reason: 'retry-cached'
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('removes equivalent Windows fallback keys before the RPC writes canonical trust', async () => {
    const entry: CodexTrustEntry = {
      ...managedEntry('stop'),
      sourcePath: String.raw`C:\Users\Alice\.codex\hooks.json`
    }
    const plan = buildPlan([entry])
    // Seed fallback trust under both Windows separator variants.
    upsertHookTrustEntries(plan.tomlPath, [entry])
    expect(readHookTrustEntries(plan.tomlPath).get(computeTrustKey(entry))?.trustedHash).toBe(
      computeTrustedHash(entry)
    )
    const runner = vi.fn(async () => {
      expect(readHookTrustEntries(plan.tomlPath).has(computeTrustKey(entry))).toBe(false)
      return grantedSessionResult([entry])
    })
    _internals.setGrantSessionRunner(runner)

    expect(
      await grantManagedCodexHookTrust(plan, () => removeSelfComputedTrustBeforeGrant(plan))
    ).toMatchObject({ lane: 'rpc' })
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

    // Model Codex's write: ledger hits require the granted hash still at its key.
    upsertHookTrustEntries(plan.tomlPath, [
      { ...entries[0], trustedHash: 'sha256:codex-session_start' }
    ])
    const second = await grantManagedCodexHookTrust(plan)
    expect(second.lane).toBe('rpc')
    expect(runner).toHaveBeenCalledTimes(1)
    expect(getCodexTrustGrantDiagnostics()).toMatchObject({ granted: 1, ledgerHits: 1 })

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

  it('keeps a config.toml save made during a failed session', async () => {
    const entries = [managedEntry('session_start')]
    const plan = buildPlan(entries)
    mkdirSync(runtimeHomeDir, { recursive: true })
    writeFileSync(plan.tomlPath, '# user formatting\r\n[hooks]\r\n')
    const savedDuringSession = '# user formatting\r\n[hooks]\r\nmodel = "saved-during-session"\r\n'
    _internals.setGrantSessionRunner(async () => {
      writeFileSync(plan.tomlPath, savedDuringSession)
      throw new Error('post-write transport failure')
    })

    expect(await grantManagedCodexHookTrust(plan)).toMatchObject({
      lane: 'fallback',
      reason: 'error'
    })
    expect(readFileSync(plan.tomlPath, 'utf8')).toBe(savedDuringSession)
  })

  it('keeps a config.toml created during a failed session', async () => {
    const entries = [managedEntry('session_start')]
    const plan = buildPlan(entries)
    mkdirSync(runtimeHomeDir, { recursive: true })
    const createdDuringSession = 'model = "created-during-session"\n'
    _internals.setGrantSessionRunner(async () => {
      writeFileSync(plan.tomlPath, createdDuringSession)
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
    expect(readFileSync(plan.tomlPath, 'utf8')).toBe(createdDuringSession)
  })
})
