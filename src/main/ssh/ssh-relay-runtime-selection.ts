import { RELAY_BUN_RUNTIME_FILENAME, relayBunRuntimeFilename } from '../../shared/relay-artifacts'
import { ORCAD_BUN_VERSION, type OrcadBunTarget } from '../../shared/orcad-bun-runtime'
import type { RemoteLinuxLibc } from './orcad-remote-target-detection'
import { shellEscape } from './ssh-connection-utils'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellLiteral } from './ssh-remote-powershell'

/** Runtime selected for relay.js. Host Node remains available for probes and rollback. */
export type RelayRuntimeKind = 'bun' | 'node'
type LinuxLibcHint = RemoteLinuxLibc | OrcadBunTarget

function normalizeLinuxLibcHint(hint: LinuxLibcHint | undefined): RemoteLinuxLibc | undefined {
  if (hint === 'glibc' || hint === 'musl') {
    return hint
  }
  if (hint?.endsWith('-glibc')) {
    return 'glibc'
  }
  if (hint?.endsWith('-musl')) {
    return 'musl'
  }
  return undefined
}

/** Path to the optional runtime shipped beside relay.js. */
export function relayBundledBunPath(
  host: RemoteHostPlatform,
  remoteDir: string,
  linuxLibc?: LinuxLibcHint
): string {
  const libc = normalizeLinuxLibcHint(linuxLibc)
  const filename =
    host.os === 'linux' && libc
      ? relayBunRuntimeFilename(`${host.os}-${host.arch}-${libc}`)
      : relayBunRuntimeFilename(host.os)
  return joinRemotePath(host, remoteDir, filename)
}

/**
 * POSIX command substitution selecting a usable bundled Bun, or the resolved
 * host Node executable for legacy relay slots. A failed Bun probe is a normal
 * compatibility outcome, never evidence that the host process exited.
 */
export function posixRelayRuntimeExpression(
  host: RemoteHostPlatform,
  remoteDir: string,
  nodePath: string,
  linuxLibc?: LinuxLibcHint
): string {
  if (isWindowsRemoteHost(host)) {
    throw new Error('POSIX relay runtime expression requires a POSIX host')
  }
  const libc = normalizeLinuxLibcHint(linuxLibc)
  // Strict deploys pass the exact staged Bun path as `nodePath`; do not probe
  // alternate names or fall back to a host executable in that mode.
  if (/[\\/](?:bun-runtime|bun-runtime-glibc|bun-runtime-musl)$/u.test(nodePath)) {
    // Callers wrap the expression in double quotes; keep the path shell-safe
    // while ensuring embedded single quotes are interpreted by the shell.
    return `$(printf '%s' ${shellEscape(nodePath)})`
  }
  const bundledCandidates = [
    ...(host.os === 'linux' && libc ? [relayBundledBunPath(host, remoteDir, libc)] : []),
    // Keep probing the generic name so packages built before the libc split can
    // still reconnect and be upgraded in place.
    joinRemotePath(host, remoteDir, RELAY_BUN_RUNTIME_FILENAME)
  ].filter((path, index, paths) => paths.indexOf(path) === index)
  const node = shellEscape(nodePath)
  const version = shellEscape(ORCAD_BUN_VERSION)
  const branches = bundledCandidates.map((path, index) => {
    const escaped = shellEscape(path)
    const keyword = index === 0 ? 'if' : 'elif'
    return `${keyword} [ -x ${escaped} ] && [ "$(${escaped} --version 2>/dev/null)" = ${version} ]; then printf '%s' ${escaped};`
  })
  // The command substitution is intentional: `( ... )` alone would run the
  // probe in a subshell and then try to execute `relay.js` as the program.
  return `$(${branches.join(' ')} else printf '%s' ${node}; fi)`
}

/**
 * PowerShell statements assigning `$runtime` to bundled Bun when it exists and
 * answers `--version`; otherwise `$runtime` remains the host Node path.
 */
export function windowsRelayRuntimeSelection(
  host: RemoteHostPlatform,
  remoteDir: string,
  nodePath: string,
  variable = '$runtime'
): string {
  if (!isWindowsRemoteHost(host)) {
    throw new Error('Windows relay runtime selection requires a Windows host')
  }
  const bun = powerShellLiteral(relayBundledBunPath(host, remoteDir))
  const node = powerShellLiteral(nodePath)
  return [
    `${variable} = ${node}`,
    `$bundledBun = ${bun}`,
    `if (Test-Path -LiteralPath $bundledBun -PathType Leaf) { try { $bunVersion = (& $bundledBun --version 2> $null | Out-String).Trim(); if ($LASTEXITCODE -eq 0 -and $bunVersion -eq ${powerShellLiteral(ORCAD_BUN_VERSION)}) { ${variable} = $bundledBun } } catch { } }`
  ].join('; ')
}
