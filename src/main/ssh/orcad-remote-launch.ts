/**
 * Starting a candidate orcad on the host and reading back what it says about itself.
 *
 * This is the piece `docs/design/shipping-orcad.html` §02 marks **fork**, not reuse: the
 * relay launches detached and proves itself by printing an `ORCA-RELAY` sentinel, and orcad
 * has no such interface. It publishes a single `orca_server_ready` JSON line on stdout,
 * carrying the health payload activation is gated on — so the handshake here is "capture
 * that line", not "match a marker".
 *
 * The candidate is launched detached with stdout redirected to a file inside its own version
 * directory. Reading readiness off the exec channel would mean holding the channel open for
 * the process's whole life; redirecting means the deploy can disconnect and the supervisor
 * still owns a running service.
 */
import { shellEscape } from './ssh-connection-utils'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  assertPosixOrcadHost as assertPosixHost,
  ORCAD_PID_FILENAME,
  posixProcessAliveShellFunction
} from './orcad-remote-host-support'
import type { ServeReadiness } from '../server/serve-readiness'
import { ORCAD_BUN_RUNTIME_FILENAME, orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import { ORCAD_BUN_TARGETS } from '../../shared/orcad-bun-runtime'
import { ORCAD_STOP_REQUEST_FILENAME } from '../../shared/orcad-stop-request'
import { quoteWindowsArgument } from '../../shared/child-process/windows-command-line'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import { z } from 'zod'

/** Stdout of the launched candidate: exactly one `orca_server_ready` line, then nothing. */
export const ORCAD_READINESS_FILENAME = '.orcad-readiness'
/** Stderr, including the bind-exposure line and every supervision message. */
export const ORCAD_LOG_FILENAME = 'orcad.log'
const ORCAD_READINESS_MAX_BYTES = 256 * 1024
const ORCAD_READINESS_TOO_LARGE = '__ORCAD_READINESS_TOO_LARGE__'
export { ORCAD_PID_FILENAME } from './orcad-remote-host-support'

export type OrcadLaunchSpec = {
  remoteInstallDir: string
  nodePath?: string
  fullVersion: string
  /** Shared across versions, and the reason rollback needs a snapshot. */
  userDataDir: string
  /** Loopback by default; the client reaches it through an SSH local port-forward. */
  bindHost: string
  port: number
  /** Only rollback may launch a pre-Bun install that has no bundled runtime. */
  allowHostNodeFallback?: boolean
}

/**
 * Launch the candidate detached and echo its PID.
 *
 * Why `--bind` is always passed explicitly: orcad defaults to loopback, but a default is a
 * thing a future version can change. The deploy states the posture it intends rather than
 * inheriting whatever the installed build happens to default to.
 */
export function orcadLaunchCommand(host: RemoteHostPlatform, spec: OrcadLaunchSpec): string {
  if (isWindowsRemoteHost(host)) {
    return windowsOrcadLaunchCommand(host, spec)
  }
  assertPosixHost(host)
  const dir = shellEscape(spec.remoteInstallDir)
  const readiness = shellEscape(
    joinRemotePath(host, spec.remoteInstallDir, ORCAD_READINESS_FILENAME)
  )
  const log = shellEscape(joinRemotePath(host, spec.remoteInstallDir, ORCAD_LOG_FILENAME))
  const pidFile = shellEscape(joinRemotePath(host, spec.remoteInstallDir, ORCAD_PID_FILENAME))
  const stopRequest = shellEscape(
    joinRemotePath(host, spec.remoteInstallDir, ORCAD_STOP_REQUEST_FILENAME)
  )
  const entry = shellEscape(joinRemotePath(host, spec.remoteInstallDir, 'orcad.js'))
  const bundledRuntime = shellEscape(
    joinRemotePath(host, spec.remoteInstallDir, orcadBunRuntimeFilename(host.os))
  )
  return [
    `cd ${dir} &&`,
    'umask 077 &&',
    `rm -f ${stopRequest} &&`,
    // Why truncate: a re-launch into a dir that already holds a previous readiness line would
    // otherwise let the deploy activate on the OLD process's health payload.
    `: > ${readiness} &&`,
    `ORCAD_RUNTIME=${bundledRuntime} &&`,
    spec.allowHostNodeFallback && spec.nodePath
      ? `if [ ! -x "$ORCAD_RUNTIME" ]; then ORCAD_RUNTIME=${shellEscape(spec.nodePath)}; fi &&`
      : 'if [ ! -x "$ORCAD_RUNTIME" ]; then echo "orcad: bundled Bun runtime is missing" >&2; exit 78; fi &&',
    `ORCA_VERSION=${shellEscape(spec.fullVersion)}`,
    `ORCA_USER_DATA=${shellEscape(spec.userDataDir)}`,
    `nohup "$ORCAD_RUNTIME" ${entry}`,
    `--json --bind ${shellEscape(spec.bindHost)} --port ${String(spec.port)}`,
    `> ${readiness} 2>> ${log} < /dev/null &`,
    `echo $! > ${pidFile} && cat ${pidFile}`
  ].join(' ')
}

function windowsOrcadLaunchCommand(host: RemoteHostPlatform, spec: OrcadLaunchSpec): string {
  const runtime = joinRemotePath(host, spec.remoteInstallDir, orcadBunRuntimeFilename(host.os))
  const legacyRuntime = joinRemotePath(host, spec.remoteInstallDir, ORCAD_BUN_RUNTIME_FILENAME)
  const entry = joinRemotePath(host, spec.remoteInstallDir, 'orcad.js')
  const readiness = joinRemotePath(host, spec.remoteInstallDir, ORCAD_READINESS_FILENAME)
  const log = joinRemotePath(host, spec.remoteInstallDir, ORCAD_LOG_FILENAME)
  const pidFile = joinRemotePath(host, spec.remoteInstallDir, ORCAD_PID_FILENAME)
  const stopRequest = joinRemotePath(host, spec.remoteInstallDir, ORCAD_STOP_REQUEST_FILENAME)
  const args = [entry, '--json', '--bind', spec.bindHost, '--port', String(spec.port)]
    .map(quoteWindowsArgument)
    .join(' ')
  const fallback =
    spec.allowHostNodeFallback && spec.nodePath
      ? `$runtime = ${powerShellLiteral(spec.nodePath)}`
      : `Write-Error 'orcad: bundled Bun runtime is missing'; exit 78`
  return powerShellCommand(
    [
      `$runtime = ${powerShellLiteral(runtime)}`,
      `if (-not (Test-Path -LiteralPath $runtime -PathType Leaf) -and (Test-Path -LiteralPath ${powerShellLiteral(legacyRuntime)})) { Write-Error 'orcad: extensionless Windows Bun slot must be rebuilt'; exit 78 }`,
      `if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) { ${fallback} }`,
      `Remove-Item -LiteralPath ${powerShellLiteral(stopRequest)} -Force -ErrorAction SilentlyContinue`,
      `[IO.File]::WriteAllText(${powerShellLiteral(readiness)}, '')`,
      `$env:ORCA_VERSION = ${powerShellLiteral(spec.fullVersion)}`,
      `$env:ORCA_USER_DATA = ${powerShellLiteral(spec.userDataDir)}`,
      `$process = Start-Process -FilePath $runtime -ArgumentList ${powerShellLiteral(args)} ` +
        `-WorkingDirectory ${powerShellLiteral(spec.remoteInstallDir)} ` +
        `-RedirectStandardOutput ${powerShellLiteral(readiness)} ` +
        `-RedirectStandardError ${powerShellLiteral(log)} -WindowStyle Hidden -PassThru -ErrorAction Stop`,
      `[IO.File]::WriteAllText(${powerShellLiteral(pidFile)}, [string]$process.Id)`,
      `Write-Output $process.Id`
    ].join('; ')
  )
}

export function readOrcadReadinessCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  if (isWindowsRemoteHost(host)) {
    const readiness = joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME)
    return powerShellCommand(
      `if (Test-Path -LiteralPath ${powerShellLiteral(readiness)} -PathType Leaf) { ` +
        `$item = Get-Item -LiteralPath ${powerShellLiteral(readiness)} -Force; ` +
        `if ($item.Length -gt ${ORCAD_READINESS_MAX_BYTES}) { ` +
        `Write-Output ${powerShellLiteral(ORCAD_READINESS_TOO_LARGE)} } else { ` +
        `Write-Output ([IO.File]::ReadAllText(${powerShellLiteral(readiness)})) } }`
    )
  }
  assertPosixHost(host)
  const readiness = shellEscape(joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME))
  return `head -c ${ORCAD_READINESS_MAX_BYTES + 1} ${readiness} 2>/dev/null || true`
}

/**
 * Is the process recorded in this version dir still running?
 *
 * Answers `LIVE`, `DEAD`, or `UNKNOWN`. `UNKNOWN` covers a missing or unparseable PID file
 * and a `kill -0` that failed for a reason other than "no such process" — a permission
 * error means someone else's process holds that PID, which is not evidence of death.
 */
export function orcadLivenessProbeCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  if (isWindowsRemoteHost(host)) {
    const pidFile = joinRemotePath(host, remoteInstallDir, ORCAD_PID_FILENAME)
    return powerShellCommand(
      [
        `$pidText = if (Test-Path -LiteralPath ${powerShellLiteral(pidFile)} -PathType Leaf) { ` +
          `[IO.File]::ReadAllText(${powerShellLiteral(pidFile)}).Trim() } else { '' }`,
        `[int]$orcadPid = 0`,
        `if (-not [int]::TryParse($pidText, [ref]$orcadPid) -or $orcadPid -le 0) { Write-Output 'UNKNOWN'; exit 0 }`,
        `$process = Get-Process -Id $orcadPid -ErrorAction SilentlyContinue`,
        `if ($null -eq $process) { Write-Output 'DEAD' } else { Write-Output 'LIVE' }`
      ].join('; ')
    )
  }
  assertPosixHost(host)
  const pidFile = shellEscape(joinRemotePath(host, remoteInstallDir, ORCAD_PID_FILENAME))
  return [
    posixProcessAliveShellFunction(),
    `pid=$(cat ${pidFile} 2>/dev/null);`,
    'case "$pid" in',
    '"" ) echo UNKNOWN;;',
    '*[!0-9]* ) echo UNKNOWN;;',
    // Why EPERM is LIVE and not DEAD: a permission error means some process holds that PID,
    // and deleting a tree because we could not signal its owner is the wrong direction.
    '* ) if orcad_alive "$pid"; then echo LIVE;',
    'elif kill -0 "$pid" 2>&1 | grep -qi "not permitted"; then echo LIVE;',
    'else echo DEAD; fi;;',
    'esac'
  ].join(' ')
}

export type OrcadLiveness = 'LIVE' | 'DEAD' | 'UNKNOWN'

export function parseOrcadLiveness(output: string): OrcadLiveness {
  const value = output.trim().split('\n').pop()?.trim()
  return value === 'LIVE' || value === 'DEAD' ? value : 'UNKNOWN'
}

/** True when GC must leave this directory alone. Inconclusive counts as in use. */
export function orcadLivenessBlocksGc(liveness: OrcadLiveness): boolean {
  return liveness !== 'DEAD'
}

export type OrcadReadinessParse =
  | { state: 'ready'; readiness: ServeReadiness }
  | { state: 'pending' }
  | { state: 'malformed'; reason: string }

const ReadinessStringSchema = z.string().min(1).max(4_096)
const OrcadPtySelfTestSchema = z.object({
  ok: z.boolean(),
  coverage: z.enum(['pty-spawn', 'handshake']),
  verdict: z.enum(['healthy', 'unreachable', 'rejected', 'pty-spawn-unhealthy', 'no-daemon']),
  durationMs: z.number().finite().nonnegative()
})
const OrcadTerminalDaemonHealthSchema = z.object({
  state: z.enum(['live', 'degraded', 'absent']),
  ownsFreshSessions: z.boolean(),
  pid: z.number().int().positive().nullable(),
  buildVersion: ReadinessStringSchema.nullable(),
  entryPath: ReadinessStringSchema.nullable(),
  protocolVersion: z.number().int().nonnegative().nullable(),
  runtimeKind: z.enum(['node', 'bun']).optional(),
  runtimeVersion: ReadinessStringSchema.optional(),
  ptyBackend: z.enum(['node-pty', 'bun-terminal']).optional(),
  selfTest: OrcadPtySelfTestSchema
})
const NodePlatformSchema = z.custom<NodeJS.Platform>(
  (value) => typeof value === 'string' && value.length > 0 && value.length <= 32
)
const OrcadHealthSchema = z.object({
  buildHash: ReadinessStringSchema,
  buildVersion: ReadinessStringSchema,
  nodeVersion: ReadinessStringSchema,
  nodeAbi: ReadinessStringSchema,
  runtimeKind: z.enum(['node', 'bun']).optional(),
  runtimeVersion: ReadinessStringSchema.optional(),
  ptyBackend: z.enum(['node-pty', 'bun-terminal']).optional(),
  buildTarget: z.enum(ORCAD_BUN_TARGETS).optional(),
  libc: z.enum(['glibc', 'musl']).optional(),
  glibcVersion: ReadinessStringSchema.optional(),
  platform: NodePlatformSchema,
  arch: ReadinessStringSchema,
  pid: z.number().int().positive(),
  terminalDaemon: OrcadTerminalDaemonHealthSchema
})
const OrcadPairingReadinessSchema = z.discriminatedUnion('available', [
  z.object({
    available: z.literal(true),
    url: ReadinessStringSchema,
    endpoint: ReadinessStringSchema,
    deviceId: ReadinessStringSchema,
    webClientUrl: z.string().max(4_096).nullable(),
    scope: z.enum(['runtime', 'mobile']),
    qr: z.string().max(1_000_000).nullable()
  }),
  z.object({
    available: z.literal(false),
    reason: z.enum([
      'websocket_unavailable',
      'device_registry_unavailable',
      'e2ee_key_unavailable',
      'invalid_advertised_endpoint',
      'relay_mint_failed',
      'network_exposure_failed',
      'disabled_by_operator'
    ]),
    guidance: z.string().max(4_096)
  })
])
const OrcadServeReadinessSchema = z.object({
  type: z.literal('orca_server_ready'),
  schemaVersion: z.literal(1),
  runtimeId: ReadinessStringSchema,
  boundEndpoint: ReadinessStringSchema.nullable(),
  advertisedEndpoint: z.string().max(4_096).nullable(),
  managedWslCliReconciliation: z.enum(['pending', 'settled', 'failed']),
  pairing: OrcadPairingReadinessSchema,
  health: OrcadHealthSchema.optional()
})

/**
 * Pull the `orca_server_ready` payload out of whatever the candidate has written so far.
 *
 * Why scan for the type tag rather than parsing the last line: stdout is a file being
 * appended to, so a poll can catch a half-written line. A partial JSON line is `pending`,
 * not `malformed` — reporting a parse failure for a race would fail deploys that were fine.
 */
export function parseOrcadReadinessOutput(raw: string): OrcadReadinessParse {
  if (
    raw.includes(ORCAD_READINESS_TOO_LARGE) ||
    Buffer.byteLength(raw, 'utf8') > ORCAD_READINESS_MAX_BYTES
  ) {
    return { state: 'malformed', reason: 'readiness payload exceeds the 256 KiB limit' }
  }
  const lines = raw.split('\n')
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return index === lines.length - 1 && !raw.endsWith('\n')
        ? { state: 'pending' }
        : { state: 'malformed', reason: 'readiness line is not valid JSON' }
    }
    const readiness = OrcadServeReadinessSchema.safeParse(parsed)
    if (!readiness.success) {
      const issue = readiness.error.issues[0]
      const path = issue?.path.length ? issue.path.join('.') : 'payload'
      return {
        state: 'malformed',
        reason: `readiness ${path} is invalid: ${issue?.message ?? 'unknown shape'}`
      }
    }
    return { state: 'ready', readiness: readiness.data }
  }
  return { state: 'pending' }
}
