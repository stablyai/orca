/**
 * orcad's health surface: the facts a supervisor needs to decide whether this deployment
 * is actually serving, as opposed to merely listening.
 *
 * The load-bearing one is the terminal-daemon verdict. orcad answers RPC from its own
 * process, so "the port is open" stays true while the daemon that owns every terminal is
 * dead — a green host that cannot run a single command. The self-test below therefore has
 * to cross the process boundary: orcad drives it, the daemon performs it, and the verdict
 * travels back over the daemon's socket.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { ORCAD_BUILD_TARGET_FILENAME } from '../../shared/orcad-artifacts'
import { ORCAD_BUN_TARGETS, type OrcadBunTarget } from '../../shared/orcad-bun-runtime'
import { checkDaemonHealthWithCoverage, type DaemonHealth } from '../daemon/daemon-health'
import {
  daemonOwnsFreshPersistentPtys,
  getDaemonEndpointFacts,
  readDaemonPidRecord
} from '../daemon/daemon-init'
import { detectNativeHostAbi } from './native-host-abi'

declare const __ORCAD_BUILD_TARGET__: string | undefined

/**
 * How much a green self-test actually proves.
 *
 * `pty-spawn` — the daemon spawned a real PTY inside its own process and it worked.
 * `handshake` — the daemon answered its protocol handshake, but did not report proof that
 *   its health request spawned a PTY. Older Windows daemons have this coverage.
 */
export type PtySelfTestCoverage = 'pty-spawn' | 'handshake'

export type PtySelfTest = {
  ok: boolean
  coverage: PtySelfTestCoverage
  /** The daemon's own verdict word, so a failure is diagnosable without re-probing. */
  verdict: DaemonHealth | 'no-daemon'
  durationMs: number
  /** Optional runtime proof from newer daemons; absent on mixed-version peers. */
  runtimeKind?: 'node' | 'bun'
  runtimeVersion?: string
  ptyBackend?: 'node-pty' | 'bun-terminal'
}

export type TerminalDaemonHealth = {
  /** `live` requires the daemon to have answered; absence is never inferred from silence. */
  state: 'live' | 'degraded' | 'absent'
  /** True only when FRESH terminals are daemon-owned, i.e. survive an orcad restart. */
  ownsFreshSessions: boolean
  pid: number | null
  /** The build the LIVE daemon was forked from, which may predate this orcad after an update. */
  buildVersion: string | null
  entryPath: string | null
  protocolVersion: number | null
  /** Runtime proof reported by the daemon that owns PTYs; absent on old daemons. */
  runtimeKind?: 'node' | 'bun'
  runtimeVersion?: string
  ptyBackend?: 'node-pty' | 'bun-terminal'
  selfTest: PtySelfTest
}

export type OrcadHealth = {
  /** Content hash of the running orcad bundle — the deployed build's identity. */
  buildHash: string
  buildVersion: string
  /** Legacy Node fields remain for mixed-version clients; Bun reports its emulated values here. */
  nodeVersion: string
  nodeAbi: string
  /** Actual JavaScript runtime, which controls built-in APIs and native addon behavior. */
  runtimeKind?: 'node' | 'bun'
  runtimeVersion?: string
  ptyBackend?: 'node-pty' | 'bun-terminal'
  /** Immutable native slot assembled with these bytes. */
  buildTarget?: OrcadBunTarget
  /** Linux C library selected for this immutable native slot. */
  libc?: 'glibc' | 'musl'
  glibcVersion?: string
  platform: NodeJS.Platform
  arch: string
  pid: number
  terminalDaemon: TerminalDaemonHealth
}

function parseOrcadBuildTarget(value: unknown): OrcadBunTarget | undefined {
  return typeof value === 'string' && ORCAD_BUN_TARGETS.includes(value as OrcadBunTarget)
    ? (value as OrcadBunTarget)
    : undefined
}

export function readOrcadBuildTarget(entryPath = process.argv[1]): OrcadBunTarget | undefined {
  if (!entryPath) {
    return undefined
  }
  try {
    return parseOrcadBuildTarget(
      readFileSync(join(dirname(entryPath), ORCAD_BUILD_TARGET_FILENAME), 'utf8').trim()
    )
  } catch {
    return undefined
  }
}

export function libcFromOrcadBuildTarget(
  buildTarget: OrcadBunTarget | undefined,
  platform: NodeJS.Platform,
  arch: string
): 'glibc' | 'musl' | undefined {
  if (!buildTarget?.startsWith(`${platform}-${arch}-`)) {
    return undefined
  }
  return buildTarget.endsWith('-musl')
    ? 'musl'
    : buildTarget.endsWith('-glibc')
      ? 'glibc'
      : undefined
}

/**
 * Identity of the exact bytes running.
 *
 * Why hash the entry and not read a version string: `ORCA_VERSION` is whatever the deploy
 * exported, so two different builds can carry one version. A rollback that did not actually
 * replace the file is precisely what this has to catch.
 */
export function computeOrcadBuildHash(entryPath = process.argv[1]): string {
  if (!entryPath) {
    return 'unknown'
  }
  try {
    return createHash('sha256').update(readFileSync(entryPath)).digest('hex').slice(0, 16)
  } catch {
    return 'unknown'
  }
}

/**
 * Probe the daemon across the process boundary.
 *
 * `checkDaemonHealth` is the cross-process test: it opens the daemon's socket, completes the
 * protocol handshake, and asks the daemon to run `ptySpawnHealth` — a real short-lived PTY
 * spawned inside the daemon. Only a daemon that is alive AND can create terminals answers
 * `healthy`; a wedged one times out to `unreachable`, and one whose node-pty or login session
 * is broken answers `pty-spawn-unhealthy`.
 */
export async function runTerminalDaemonSelfTest(
  now: () => number = () => Date.now()
): Promise<PtySelfTest> {
  const startedAt = now()
  const facts = getDaemonEndpointFacts()
  if (!facts) {
    return {
      ok: false,
      coverage: process.platform === 'win32' ? 'handshake' : 'pty-spawn',
      verdict: 'no-daemon',
      durationMs: now() - startedAt
    }
  }
  const result = await checkDaemonHealthWithCoverage(facts.socketPath, facts.tokenPath)
  return {
    ok: result.verdict === 'healthy',
    coverage: result.coverage,
    verdict: result.verdict,
    durationMs: now() - startedAt,
    ...(result.runtimeKind ? { runtimeKind: result.runtimeKind } : {}),
    ...(result.runtimeVersion ? { runtimeVersion: result.runtimeVersion } : {}),
    ...(result.ptyBackend ? { ptyBackend: result.ptyBackend } : {})
  }
}

export async function collectTerminalDaemonHealth(): Promise<TerminalDaemonHealth> {
  const facts = getDaemonEndpointFacts()
  const selfTest = await runTerminalDaemonSelfTest()
  if (!facts) {
    return {
      state: 'absent',
      ownsFreshSessions: false,
      pid: null,
      buildVersion: null,
      entryPath: null,
      protocolVersion: null,
      selfTest
    }
  }
  const record = readDaemonPidRecord()
  const ownsFreshSessions = daemonOwnsFreshPersistentPtys()
  return {
    // Why `degraded` and not `absent` on a failed self-test: a daemon that answered its
    // handshake but failed the spawn probe is still holding live sessions. Reporting it gone
    // would invite a caller to treat those terminals as exited, which is the one verdict the
    // execution-boundary vocabulary forbids guessing.
    state:
      selfTest.ok && ownsFreshSessions
        ? 'live'
        : selfTest.verdict === 'no-daemon'
          ? 'absent'
          : 'degraded',
    ownsFreshSessions,
    pid: record?.pid ?? null,
    buildVersion: record?.appVersion ?? null,
    entryPath: record?.entryPath ?? null,
    protocolVersion: facts.protocolVersion,
    ...(selfTest.runtimeKind ? { runtimeKind: selfTest.runtimeKind } : {}),
    ...(selfTest.runtimeVersion ? { runtimeVersion: selfTest.runtimeVersion } : {}),
    ...(selfTest.ptyBackend ? { ptyBackend: selfTest.ptyBackend } : {}),
    selfTest
  }
}

export async function collectOrcadHealth(buildVersion: string): Promise<OrcadHealth> {
  const bunVersion = (process.versions as typeof process.versions & { bun?: string }).bun
  const runtimeKind = bunVersion ? 'bun' : 'node'
  const nativeAbi = detectNativeHostAbi()
  const embeddedBuildTarget =
    typeof __ORCAD_BUILD_TARGET__ === 'string'
      ? parseOrcadBuildTarget(__ORCAD_BUILD_TARGET__)
      : undefined
  const buildTarget = readOrcadBuildTarget() ?? embeddedBuildTarget
  const targetLibc = libcFromOrcadBuildTarget(buildTarget, process.platform, process.arch)
  const libc =
    process.platform !== 'linux'
      ? undefined
      : (targetLibc ?? (nativeAbi.libc === 'musl' ? 'musl' : 'glibc'))
  return {
    buildHash: computeOrcadBuildHash(),
    buildVersion,
    nodeVersion: process.versions.node,
    nodeAbi: process.versions.modules ?? 'unknown',
    runtimeKind,
    ...(bunVersion ? { runtimeVersion: bunVersion } : {}),
    ptyBackend: bunVersion ? 'bun-terminal' : 'node-pty',
    ...(buildTarget ? { buildTarget } : {}),
    ...(libc ? { libc } : {}),
    ...(libc === 'glibc' && nativeAbi.glibcVersion ? { glibcVersion: nativeAbi.glibcVersion } : {}),
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    terminalDaemon: await collectTerminalDaemonHealth()
  }
}

let cachedHealth: { buildVersion: string; collectedAt: number; health: OrcadHealth } | null = null
let healthInFlight: { buildVersion: string; promise: Promise<OrcadHealth> } | null = null

/** Bounds PTY self-test churn when supervisors poll the authenticated health RPC. */
export async function collectCachedOrcadHealth(
  buildVersion: string,
  now: () => number = () => Date.now()
): Promise<OrcadHealth> {
  const currentTime = now()
  if (
    cachedHealth?.buildVersion === buildVersion &&
    currentTime - cachedHealth.collectedAt < 5_000
  ) {
    return cachedHealth.health
  }
  if (healthInFlight?.buildVersion === buildVersion) {
    return healthInFlight.promise
  }
  const promise = collectOrcadHealth(buildVersion)
  healthInFlight = { buildVersion, promise }
  try {
    const health = await promise
    cachedHealth = { buildVersion, collectedAt: now(), health }
    return health
  } finally {
    if (healthInFlight?.promise === promise) {
      healthInFlight = null
    }
  }
}
