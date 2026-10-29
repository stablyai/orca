import { randomUUID } from 'node:crypto'
import type { RemoteInstallTransport } from './remote-install-transport'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { execHostCommand } from '../../ssh/remote-exec/remote-host-exec'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import {
  probeInstallLockExistsCommand,
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand
} from './remote-install-lock-commands'
import { removeRemoteTreeCommand } from '../../ssh/ssh-remote-commands'
import { powerShellCommand } from '../../ssh/ssh-remote-powershell'
import { quotePowerShellLiteral as powerShellLiteral } from '../../../shared/powershell-native-argument'
import {
  getRemoteHostPlatform,
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'

const DEFAULT_REMOTE_HOST = getRemoteHostPlatform('linux-x64')
const RELAY_GC_CLAIM_SUFFIX = '.gc-claim'
const RELAY_GC_OWNER_NAME = '.gc-owner'
// Ten minutes exceeds bounded rename/launch handoffs while permitting crashed-claim recovery.
const RELAY_GC_CLAIM_STALE_SECONDS = 10 * 60

export function relayGcClaimPath(remoteRelayDir: string): string {
  return `${remoteRelayDir}${RELAY_GC_CLAIM_SUFFIX}`
}

export async function isRelayGcClaimed(
  conn: RemoteInstallTransport,
  remoteRelayDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  signal?: AbortSignal
): Promise<boolean> {
  const claimPath = relayGcClaimPath(remoteRelayDir)
  const output = await execHostCommand(conn, host, probeInstallLockExistsCommand(host, claimPath), {
    signal
  })
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
  conn: RemoteInstallTransport,
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
      { signal }
    )
    if (created.trim().endsWith('OK')) {
      return writeRelayGcClaimOwner(conn, remoteRelayDir, host, signal)
    }
    const stolen = await execHostCommand(
      conn,
      host,
      tryStealInstallLockCommand(host, claimPath, RELAY_GC_CLAIM_STALE_SECONDS),
      { signal }
    )
    if (!stolen.trim().endsWith('OK')) {
      return null
    }
    return writeRelayGcClaimOwner(conn, remoteRelayDir, host, signal)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    signal?.throwIfAborted()
    return null
  }
}

async function writeRelayGcClaimOwner(
  conn: RemoteInstallTransport,
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
    : `printf %s ${quotePosixShell(token)} > ${quotePosixShell(ownerPath)}`
  try {
    await execHostCommand(conn, host, command, { signal })
    return token
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    // A lost reply may hide a successful write; release only our token's generation.
    await releaseRelayGcClaim(conn, remoteRelayDir, token, host)
    return null
  }
}

export async function isRelayGcClaimOwned(
  conn: RemoteInstallTransport,
  remoteRelayDir: string,
  token: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST
): Promise<boolean> {
  const ownerPath = joinRemotePath(host, relayGcClaimPath(remoteRelayDir), RELAY_GC_OWNER_NAME)
  const command = isWindowsRemoteHost(host)
    ? powerShellCommand(
        `if ((Get-Content -LiteralPath ${powerShellLiteral(ownerPath)} -Raw -ErrorAction SilentlyContinue) -ceq ${powerShellLiteral(token)}) { 'OWNED' } else { 'LOST' }`
      )
    : `test "$(cat ${quotePosixShell(ownerPath)} 2>/dev/null)" = ${quotePosixShell(token)} && echo OWNED || echo LOST`
  const output = await execHostCommand(conn, host, command).catch((error) => {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return 'LOST'
  })
  return output.trim() === 'OWNED'
}

type RelayGcClaimReleaseResult = 'released' | 'lost' | 'unknown'

export async function releaseRelayGcClaim(
  conn: RemoteInstallTransport,
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
          `elseif ((Get-Content -LiteralPath ${powerShellLiteral(ownerPath)} -Raw -ErrorAction SilentlyContinue) -cne ${powerShellLiteral(token)}) { 'LOST' } ` +
          'else { try { Remove-Item -LiteralPath $claim -Recurse -Force -ErrorAction Stop } catch {}; ' +
          "if (Test-Path -LiteralPath $claim) { 'UNKNOWN' } else { 'RELEASED' } }"
      )
    : [
        `if ! test -e ${quotePosixShell(claimPath)}; then echo RELEASED;`,
        `elif test "$(cat ${quotePosixShell(ownerPath)} 2>/dev/null)" != ${quotePosixShell(token)}; then echo LOST;`,
        `else ${removeRemoteTreeCommand(host, claimPath)} 2>/dev/null;`,
        `if test -e ${quotePosixShell(claimPath)}; then echo UNKNOWN; else echo RELEASED; fi; fi`
      ].join(' ')
  const output = await execHostCommand(conn, host, command).catch((error) => {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return 'UNKNOWN'
  })
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
  conn: RemoteInstallTransport,
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
  conn: RemoteInstallTransport,
  remoteRelayDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  signal?: AbortSignal
): Promise<void> {
  while (true) {
    const claimed = await isRelayGcClaimed(conn, remoteRelayDir, host, signal).catch((error) => {
      if (isUnconfirmedSshCommandTermination(error)) {
        throw error
      }
      return true
    })
    signal?.throwIfAborted()
    if (!claimed) {
      return
    }
    const claimPath = relayGcClaimPath(remoteRelayDir)
    const recovered = await execHostCommand(
      conn,
      host,
      tryStealInstallLockCommand(host, claimPath, RELAY_GC_CLAIM_STALE_SECONDS),
      { signal }
    ).catch((error) => {
      if (isUnconfirmedSshCommandTermination(error)) {
        throw error
      }
      return 'BUSY'
    })
    signal?.throwIfAborted()
    if (recovered.trim().endsWith('OK')) {
      const token = await writeRelayGcClaimOwner(conn, remoteRelayDir, host, signal)
      if (token) {
        const release = await releaseRelayGcClaim(conn, remoteRelayDir, token, host)
        if (release === 'released') {
          return
        }
      }
      // An uncertain release may leave a successor at the stable path; probe again.
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
