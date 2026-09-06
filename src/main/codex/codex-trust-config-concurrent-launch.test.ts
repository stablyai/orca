import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexHookTrustGrantRequest,
  CodexHookTrustGrantSessionResult
} from './codex-app-server-client'
import type { CodexManagedTrustGrantPlan } from './codex-hook-trust-grant'
import type { CodexTrustEntry } from './config-toml-trust'

const testState = {
  fakeHomeDir: '',
  userDataDir: '',
  previousUserDataPath: undefined as string | undefined
}

vi.mock('node:os', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => testState.fakeHomeDir }
})

const { CodexAppServerUnsupportedError } = await import('./codex-app-server-client')
const { codexAppServerCapabilityCache } = await import('./codex-app-server-capability-cache')
const { _internals, grantManagedCodexHookTrust } = await import('./codex-hook-trust-grant')
const { markCodexProjectTrusted } = await import('../agent-trust-presets')
const { setCodexTrustGrantTelemetry } = await import('./codex-trust-grant-telemetry')
const {
  computeTrustKey,
  computeTrustedHash,
  normalizeHookTrustKeyForLookup,
  readHookTrustEntries,
  upsertHookTrustEntries
} = await import('./config-toml-trust')

let runtimeHomeDir: string

beforeEach(() => {
  testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-concurrent-home-'))
  testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-concurrent-userdata-'))
  testState.previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = testState.userDataDir
  runtimeHomeDir = join(testState.userDataDir, 'codex-runtime-home', 'home')
  mkdirSync(runtimeHomeDir, { recursive: true })
  writeFileSync(join(runtimeHomeDir, 'hooks.json'), '{"hooks":{}}\n', 'utf-8')
  mkdirSync(join(testState.fakeHomeDir, '.codex'), { recursive: true })
  codexAppServerCapabilityCache.clear()
  _internals.resetDiagnostics()
})

afterEach(() => {
  _internals.setGrantSessionRunner(null)
  setCodexTrustGrantTelemetry(() => {})
  codexAppServerCapabilityCache.clear()
  if (testState.previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = testState.previousUserDataPath
  }
  delete process.env.ORCA_DISABLE_CODEX_TRUST_RPC
  rmSync(testState.fakeHomeDir, { recursive: true, force: true })
  rmSync(testState.userDataDir, { recursive: true, force: true })
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
  overrides: Partial<CodexManagedTrustGrantPlan> = {}
): CodexManagedTrustGrantPlan {
  return {
    runtimeHomePath: runtimeHomeDir,
    tomlPath: join(runtimeHomeDir, 'config.toml'),
    managedCommand: MANAGED_COMMAND,
    managedEntries: entries,
    host: { kind: 'native' },
    telemetryLane: 'real-home',
    ...overrides
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Stands in for codex app-server: really writes the trust entries into
 *  config.toml across an await, like the RPC does. */
function writingSessionRunner(args: {
  tomlPath: string
  entries: CodexTrustEntry[]
  hashPrefix: string
  gate?: Promise<void>
  outcome?: 'granted' | 'verify-failed'
}) {
  return async (
    _request: CodexHookTrustGrantRequest
  ): Promise<CodexHookTrustGrantSessionResult> => {
    const granted = args.entries.map((entry) => {
      const key = computeTrustKey(entry)
      return {
        key,
        normalizedKey: normalizeHookTrustKeyForLookup(key),
        trustedHash: `${args.hashPrefix}${entry.eventLabel}`
      }
    })
    await tick()
    upsertHookTrustEntries(
      args.tomlPath,
      args.entries.map((entry, index) => ({ ...entry, trustedHash: granted[index].trustedHash }))
    )
    if (args.gate) {
      await args.gate
    }
    if (args.outcome === 'verify-failed') {
      return {
        outcome: 'verify-failed',
        reason: 'listed hash mismatch',
        reasonClass: 'post-grant-mismatch'
      }
    }
    return { outcome: 'granted', wroteTrust: true, entries: granted }
  }
}

describe('two Codex pane launches against one config.toml', () => {
  it('does not let a failing launch roll back a concurrent launch that already succeeded', async () => {
    // Why warm: on a cold host the shared capability probe incidentally
    // serializes the two launches. Once the host is known-supported that
    // dedupe is bypassed and the per-file lane is the only thing left.
    codexAppServerCapabilityCache.rememberSupported('native')
    const tomlPath = join(runtimeHomeDir, 'config.toml')
    const entries = [managedEntry('session_start')]
    let sessionsInFlight = 0
    let maxSessionsInFlight = 0
    let call = 0
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    _internals.setGrantSessionRunner(async (request) => {
      sessionsInFlight += 1
      maxSessionsInFlight = Math.max(maxSessionsInFlight, sessionsInFlight)
      call += 1
      const isFirst = call === 1
      try {
        return await writingSessionRunner({
          tomlPath,
          entries,
          hashPrefix: isFirst ? 'sha256:doomed-' : 'sha256:survivor-',
          gate: isFirst ? firstGate : undefined,
          outcome: isFirst ? 'verify-failed' : 'granted'
        })(request)
      } finally {
        sessionsInFlight -= 1
      }
    })

    const doomed = grantManagedCodexHookTrust(buildPlan(entries))
    const survivor = grantManagedCodexHookTrust(buildPlan(entries))
    await tick()
    await tick()
    releaseFirst()

    expect(await doomed).toMatchObject({ lane: 'fallback', reason: 'verify-failed' })
    expect(await survivor).toMatchObject({ lane: 'rpc' })
    // The doomed run's rollback must not resurrect the pre-grant file over
    // the entries the survivor legitimately wrote.
    const trust = readHookTrustEntries(tomlPath)
    const key = normalizeHookTrustKeyForLookup(computeTrustKey(entries[0]))
    expect(trust.get(key)?.trustedHash).toBe('sha256:survivor-session_start')
    expect(maxSessionsInFlight).toBe(1)
  })

  it('keeps a concurrent markCodexProjectTrusted write out of a grant rollback window', async () => {
    codexAppServerCapabilityCache.rememberSupported('native')
    const tomlPath = join(runtimeHomeDir, 'config.toml')
    const entries = [managedEntry('session_start')]
    const workspace = mkdtempSync(join(tmpdir(), 'orca-concurrent-ws-'))
    let releaseSession!: () => void
    const sessionGate = new Promise<void>((resolve) => {
      releaseSession = resolve
    })

    _internals.setGrantSessionRunner(
      writingSessionRunner({
        tomlPath,
        entries,
        hashPrefix: 'sha256:doomed-',
        gate: sessionGate,
        outcome: 'verify-failed'
      })
    )

    try {
      const grant = grantManagedCodexHookTrust(buildPlan(entries))
      // Let the grant capture config.toml and start its session.
      await tick()
      await tick()
      const marked = markCodexProjectTrusted(workspace)
      await tick()
      // The lane must hold the preset write back until rollback has run.
      expect(readFileSync(tomlPath, 'utf-8')).not.toContain('trust_level')

      releaseSession()
      expect(await grant).toMatchObject({ lane: 'fallback', reason: 'verify-failed' })
      await marked

      expect(readFileSync(tomlPath, 'utf-8')).toContain('trust_level = "trusted"')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('concurrent capability probes against a cold host', () => {
  it('shares one app-server session between two launches on different config files', async () => {
    const secondHome = join(testState.userDataDir, 'second-runtime-home')
    mkdirSync(secondHome, { recursive: true })
    writeFileSync(join(secondHome, 'hooks.json'), '{"hooks":{}}\n', 'utf-8')
    const entries = [managedEntry('session_start')]
    let sessions = 0
    let releaseProbe!: () => void
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    _internals.setGrantSessionRunner(async () => {
      sessions += 1
      await probeGate
      throw new CodexAppServerUnsupportedError('hooks/grantTrust: method not found')
    })

    const first = grantManagedCodexHookTrust(buildPlan(entries))
    const second = grantManagedCodexHookTrust(
      buildPlan([{ ...entries[0], sourcePath: join(secondHome, 'hooks.json') }], {
        runtimeHomePath: secondHome,
        tomlPath: join(secondHome, 'config.toml')
      })
    )
    await tick()
    await tick()
    expect(sessions).toBe(1)
    releaseProbe()

    expect(await first).toMatchObject({ lane: 'fallback', reason: 'unsupported' })
    expect(await second).toMatchObject({ lane: 'fallback', reason: 'unsupported-cached' })
    expect(sessions).toBe(1)
  })

  it('leaves the waiter config.toml untouched when the shared probe reports unsupported', async () => {
    const secondHome = join(testState.userDataDir, 'second-runtime-home')
    mkdirSync(secondHome, { recursive: true })
    writeFileSync(join(secondHome, 'hooks.json'), '{"hooks":{}}\n', 'utf-8')
    const waiterToml = join(secondHome, 'config.toml')
    const waiterEntry = {
      ...managedEntry('session_start'),
      sourcePath: join(secondHome, 'hooks.json')
    }
    // Self-computed trust the fallback lane already wrote for this pane.
    upsertHookTrustEntries(waiterToml, [
      { ...waiterEntry, trustedHash: computeTrustedHash(waiterEntry) }
    ])
    const before = readFileSync(waiterToml, 'utf-8')

    let releaseProbe!: () => void
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    _internals.setGrantSessionRunner(async () => {
      await probeGate
      throw new CodexAppServerUnsupportedError('hooks/grantTrust: method not found')
    })

    const first = grantManagedCodexHookTrust(buildPlan([managedEntry('session_start')]))
    const waiter = grantManagedCodexHookTrust(
      buildPlan([waiterEntry], { runtimeHomePath: secondHome, tomlPath: waiterToml })
    )
    await tick()
    releaseProbe()
    await first
    expect(await waiter).toMatchObject({ lane: 'fallback', reason: 'unsupported-cached' })
    expect(readFileSync(waiterToml, 'utf-8')).toBe(before)
  })
})

describe('host-scoped transient cooldown', () => {
  // Why: the cooldown lives outside the per-file lane, so a failure on one
  // pane's config.toml has to suppress every other pane on that host and
  // nothing on a different one.
  it('suppresses a second config.toml on the same host but not another host', async () => {
    const secondHome = join(testState.userDataDir, 'second-runtime-home')
    mkdirSync(secondHome, { recursive: true })
    writeFileSync(join(secondHome, 'hooks.json'), '{"hooks":{}}\n', 'utf-8')
    const entries = [managedEntry('session_start')]
    let calls = 0
    _internals.setGrantSessionRunner(() => {
      calls += 1
      throw new Error('spawn ETIMEDOUT')
    })

    expect(await grantManagedCodexHookTrust(buildPlan(entries))).toMatchObject({
      lane: 'fallback',
      reason: 'error'
    })
    expect(
      await grantManagedCodexHookTrust(
        buildPlan([{ ...entries[0], sourcePath: join(secondHome, 'hooks.json') }], {
          runtimeHomePath: secondHome,
          tomlPath: join(secondHome, 'config.toml')
        })
      )
    ).toMatchObject({ lane: 'fallback', reason: 'retry-cached' })
    expect(calls).toBe(1)

    // A WSL distro runs its own codex binary; the native cooldown must not reach it.
    expect(
      await grantManagedCodexHookTrust(
        buildPlan(entries, {
          host: { kind: 'wsl', distro: 'Ubuntu', linuxRuntimeHome: '/home/u/.codex' }
        })
      )
    ).toMatchObject({ lane: 'fallback', reason: 'error' })
    expect(calls).toBe(2)
  })

  // Why: the cooldown check runs before the lane, so a launch already admitted
  // can succeed after a sibling failed. That proof of health must clear the
  // sibling's cooldown instead of suppressing the host for five more minutes.
  it('lets a concurrent success clear a cooldown a sibling failure just set', async () => {
    codexAppServerCapabilityCache.rememberSupported('native')
    const secondHome = join(testState.userDataDir, 'second-runtime-home')
    mkdirSync(secondHome, { recursive: true })
    writeFileSync(join(secondHome, 'hooks.json'), '{"hooks":{}}\n', 'utf-8')
    const entries = [managedEntry('session_start')]
    const okEntry = { ...entries[0], sourcePath: join(secondHome, 'hooks.json') }
    const okToml = join(secondHome, 'config.toml')
    const okPlan = buildPlan([okEntry], { runtimeHomePath: secondHome, tomlPath: okToml })

    let releaseFailure!: () => void
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve
    })
    let sessions = 0
    _internals.setGrantSessionRunner(async (request) => {
      sessions += 1
      if (request.hooksListCwd === runtimeHomeDir) {
        await failureGate
        throw new Error('spawn ETIMEDOUT')
      }
      return writingSessionRunner({
        tomlPath: okToml,
        entries: [okEntry],
        hashPrefix: 'sha256:ok-'
      })(request)
    })

    const failing = grantManagedCodexHookTrust(buildPlan(entries))
    const succeeding = grantManagedCodexHookTrust(okPlan)
    releaseFailure()
    expect(await failing).toMatchObject({ lane: 'fallback', reason: 'error' })
    expect(await succeeding).toMatchObject({ lane: 'rpc' })

    // A later launch on the same host must reach the RPC, not the cooldown.
    // The ledger is shared across runtime homes, so clear it to force a session.
    rmSync(join(testState.userDataDir, 'codex-runtime-home', 'trust-grant-ledger.json'), {
      force: true
    })
    expect(sessions).toBe(2)
    expect(await grantManagedCodexHookTrust(okPlan)).toMatchObject({ lane: 'rpc' })
    expect(sessions).toBe(3)
  })
})

describe('reentrancy under concurrency', () => {
  it('completes a grant nested inside an installer that already holds both lanes', async () => {
    const { runExclusivelyForCodexTrustConfig } =
      await import('./codex-trust-config-mutation-queue')
    const entries = [managedEntry('session_start')]
    const tomlPath = join(runtimeHomeDir, 'config.toml')
    const systemToml = join(testState.fakeHomeDir, '.codex', 'config.toml')
    _internals.setGrantSessionRunner(
      writingSessionRunner({ tomlPath, entries, hashPrefix: 'sha256:nested-' })
    )
    const workspace = mkdtempSync(join(tmpdir(), 'orca-nested-ws-'))
    try {
      // Installer lock order: runtime then system, with a grant and a preset
      // write nested inside both.
      const outcome = await runExclusivelyForCodexTrustConfig(tomlPath, () =>
        runExclusivelyForCodexTrustConfig(systemToml, async () => {
          await markCodexProjectTrusted(workspace)
          return grantManagedCodexHookTrust(buildPlan(entries))
        })
      )
      expect(outcome).toMatchObject({ lane: 'rpc' })
      expect(readFileSync(tomlPath, 'utf-8')).toContain('trust_level = "trusted"')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 5000)
})
