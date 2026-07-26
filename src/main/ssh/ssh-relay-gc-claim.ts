import { randomUUID } from 'node:crypto'
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  probeInstallLockExistsCommand,
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand
} from './ssh-relay-install-lock-commands'
import { removeRemoteTreeCommand } from './ssh-remote-commands'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import {
  posixReadRelayMarkerAssignment,
  powerShellReadRelayMarkerAssignment
} from './ssh-relay-bounded-marker-commands'
import {
  getRemoteHostPlatform,
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from './ssh-remote-platform'

const DEFAULT_REMOTE_HOST = getRemoteHostPlatform('linux-x64')
const RELAY_GC_CLAIM_SUFFIX = '.gc-claim'
const RELAY_GC_OWNER_NAME = '.gc-owner'
// Why: the claim guards only a bounded sibling rename or launch handoff, not
// npm or deletion. Ten minutes bounds crashes while exceeding either sequence.
const RELAY_GC_CLAIM_STALE_SECONDS = 10 * 60

function execHostCommand(
  conn: SshConnection,
  host: RemoteHostPlatform,
  command: string,
  signal?: AbortSignal
): Promise<string> {
  return execCommand(conn, command, {
    wrapCommand: !isWindowsRemoteHost(host),
    signal
  })
}

export function relayGcClaimPath(remoteRelayDir: string): string {
  return `${remoteRelayDir}${RELAY_GC_CLAIM_SUFFIX}`
}

export async function isRelayGcClaimed(
  conn: SshConnection,
  remoteRelayDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  signal?: AbortSignal
): Promise<boolean> {
  const claimPath = relayGcClaimPath(remoteRelayDir)
  const output = await execHostCommand(
    conn,
    host,
    probeInstallLockExistsCommand(host, claimPath),
    signal
  )
  const markers = new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line === 'LOCKED' || line === 'OPEN')
  )
  if (markers.size !== 1) {
    throw new Error(`Inconclusive relay GC claim probe at ${claimPath}`)
  }
  return markers.has('LOCKED')
}

export async function tryAcquireRelayGcClaim(
  conn: SshConnection,
  remoteRelayDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  signal?: AbortSignal
): Promise<string | null> {
  const claimPath = relayGcClaimPath(remoteRelayDir)
  try {
    const created = await execHostCommand(
      conn,
      host,
      tryCreateInstallLockCommand(host, claimPath),
      signal
    )
    if (created.trim().endsWith('OK')) {
      return writeRelayGcClaimOwner(conn, remoteRelayDir, host, signal)
    }
    const stolen = await execHostCommand(
      conn,
      host,
      tryStealInstallLockCommand(host, claimPath, RELAY_GC_CLAIM_STALE_SECONDS),
      signal
    )
    if (!stolen.trim().endsWith('OK')) {
      return null
    }
    return writeRelayGcClaimOwner(conn, remoteRelayDir, host, signal)
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

async function writeRelayGcClaimOwner(
  conn: SshConnection,
  remoteRelayDir: string,
  host: RemoteHostPlatform,
  signal?: AbortSignal
): Promise<string | null> {
  const token = `${process.pid}-${Date.now()}-${randomUUID()}`
  const claimPath = relayGcClaimPath(remoteRelayDir)
  const ownerPath = joinRemotePath(host, claimPath, RELAY_GC_OWNER_NAME)
  const command = isWindowsRemoteHost(host)
    ? powerShellCommand(
        `Set-Content -LiteralPath ${powerShellLiteral(ownerPath)} -Value ${powerShellLiteral(token)} -NoNewline -ErrorAction Stop`
      )
    : `printf %s ${shellEscape(token)} > ${shellEscape(ownerPath)}`
  try {
    await execHostCommand(conn, host, command, signal)
    return token
  } catch {
    // Why: the write may have succeeded remotely before SSH lost its reply.
    // A conditional release removes only the claim generation with our token.
    await releaseRelayGcClaim(conn, remoteRelayDir, token, host)
    return null
  }
}

export async function isRelayGcClaimOwned(
  conn: SshConnection,
  remoteRelayDir: string,
  token: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST
): Promise<boolean> {
  const ownerPath = joinRemotePath(host, relayGcClaimPath(remoteRelayDir), RELAY_GC_OWNER_NAME)
  const command = isWindowsRemoteHost(host)
    ? powerShellCommand(
        `${powerShellReadRelayMarkerAssignment(ownerPath)}; if ($orcaMarkerValue -ceq ${powerShellLiteral(token)}) { 'OWNED' } else { 'LOST' }`
      )
    : `${posixReadRelayMarkerAssignment(ownerPath)}; test "$orca_marker" = ${shellEscape(token)} && echo OWNED || echo LOST`
  const output = await execHostCommand(conn, host, command).catch(() => 'LOST')
  return output.trim() === 'OWNED'
}

export type RelayGcClaimReleaseResult = 'released' | 'lost' | 'unknown'

export async function releaseRelayGcClaim(
  conn: SshConnection,
  remoteRelayDir: string,
  token: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST
): Promise<RelayGcClaimReleaseResult> {
  const claimPath = relayGcClaimPath(remoteRelayDir)
  const ownerPath = joinRemotePath(host, claimPath, RELAY_GC_OWNER_NAME)
  const command = isWindowsRemoteHost(host)
    ? powerShellCommand(
        `$claim = ${powerShellLiteral(claimPath)}; ` +
          `if (-not (Test-Path -LiteralPath $claim)) { 'RELEASED' } ` +
          `else { ${powerShellReadRelayMarkerAssignment(ownerPath)}; ` +
          `if ($orcaMarkerValue -cne ${powerShellLiteral(token)}) { 'LOST' } ` +
          'else { try { Remove-Item -LiteralPath $claim -Recurse -Force -ErrorAction Stop } catch {}; ' +
          "if (Test-Path -LiteralPath $claim) { 'UNKNOWN' } else { 'RELEASED' } } }"
      )
    : [
        `if ! test -e ${shellEscape(claimPath)}; then echo RELEASED;`,
        `else ${posixReadRelayMarkerAssignment(ownerPath)};`,
        `if test "$orca_marker" != ${shellEscape(token)}; then echo LOST;`,
        `else ${removeRemoteTreeCommand(host, claimPath)} 2>/dev/null;`,
        `if test -e ${shellEscape(claimPath)}; then echo UNKNOWN; else echo RELEASED; fi; fi; fi`
      ].join(' ')
  const output = await execHostCommand(conn, host, command).catch(() => 'UNKNOWN')
  switch (output.trim()) {
    case 'RELEASED':
      return 'released'
    case 'LOST':
      return 'lost'
    default:
      return 'unknown'
  }
}

export async function releaseRelayGcClaimWithRetry(
  conn: SshConnection,
  remoteRelayDir: string,
  token: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST
): Promise<RelayGcClaimReleaseResult> {
  let result: RelayGcClaimReleaseResult = 'unknown'
  for (let attempt = 0; attempt < 3 && result === 'unknown'; attempt++) {
    result = await releaseRelayGcClaim(conn, remoteRelayDir, token, host)
  }
  return result
}

export async function waitForRelayGcClaimRelease(
  conn: SshConnection,
  remoteRelayDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  signal?: AbortSignal
): Promise<void> {
  while (true) {
    const claimed = await isRelayGcClaimed(conn, remoteRelayDir, host, signal).catch(() => true)
    signal?.throwIfAborted()
    if (!claimed) {
      return
    }
    const claimPath = relayGcClaimPath(remoteRelayDir)
    const recovered = await execHostCommand(
      conn,
      host,
      tryStealInstallLockCommand(host, claimPath, RELAY_GC_CLAIM_STALE_SECONDS),
      signal
    ).catch(() => 'BUSY')
    signal?.throwIfAborted()
    if (recovered.trim().endsWith('OK')) {
      const token = await writeRelayGcClaimOwner(conn, remoteRelayDir, host, signal)
      if (token) {
        const release = await releaseRelayGcClaim(conn, remoteRelayDir, token, host)
        if (release === 'released') {
          return
        }
      }
      // A lost or uncertain release can mean a successor owns the stable path.
      // Probe again instead of treating recovery as complete.
      continue
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(signal?.reason)
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, 1_000)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
      }
    })
  }
}
