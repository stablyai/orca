/**
 * Keeps the remote relay's Unix socket path inside `sockaddr_un.sun_path`.
 *
 * The default endpoint is `$HOME/.orca-remote/relay-<fullVersion>/relay-<id>.sock`,
 * whose fixed suffix already costs ~66 bytes. A managed-hosting `$HOME` such as
 * `/var/www/<uuid>` pushes the whole path past the kernel cap and libuv reports only
 * `listen EINVAL`, so the relay never starts (#10726). When that happens the socket
 * moves to a fixed-length base whose length no longer depends on `$HOME`.
 *
 * Windows relays bind named pipes (`\\.\pipe\...`), which have no `sun_path` limit.
 */
import { createHash } from 'node:crypto'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

/**
 * `sizeof(sun_path)` per remote OS, including the terminating NUL: 108 on Linux,
 * 104 on macOS/BSD. Compared against byte length, not character count — a non-ASCII
 * `$HOME` costs more bytes than characters.
 */
const SUN_PATH_SIZE: Record<'linux' | 'darwin', number> = { linux: 108, darwin: 104 }

export function remoteUnixSocketPathByteLimit(host: RemoteHostPlatform): number | null {
  if (isWindowsRemoteHost(host)) {
    return null
  }
  return SUN_PATH_SIZE[host.os === 'darwin' ? 'darwin' : 'linux'] - 1
}

export function remoteSocketPathFitsLimit(host: RemoteHostPlatform, sockPath: string): boolean {
  const limit = remoteUnixSocketPathByteLimit(host)
  return limit === null || Buffer.byteLength(sockPath, 'utf8') <= limit
}

/** Fixed-length, per-uid base. `/tmp` is the only POSIX directory whose length is not user-dependent. */
export const SHORT_RELAY_SOCKET_DIR_PREFIX = '/tmp/.orca-relay-'

export function shortRelaySocketDirForUid(uid: string): string {
  return `${SHORT_RELAY_SOCKET_DIR_PREFIX}${uid}`
}

/**
 * The version segment the relocated socket lives under, named to match the version
 * directories in `$HOME/.orca-remote` so one sweep pattern covers both bases.
 *
 * Why it has to exist: `relaySocketNameForInstanceId` hashes the *target*, not the
 * build, so the filename alone is version-independent. Under `$HOME` the enclosing
 * `relay-<fullVersion>` directory supplies that dimension; without it here, the next
 * Orca build would bind the exact path the previous build's relay still holds. The
 * daemon handshake compares build hashes exactly, so that meeting is a version
 * mismatch — and if the incumbent holds live work, `resolveRelayEndpointBeforeRelaunch`
 * raises `RelayEndpointHeldError` and the user cannot connect at all until the old
 * relay is stopped. The version is hashed rather than spelled out because the whole
 * point of this base is a bounded length.
 */
export function shortRelayVersionSegment(relayVersionDirName: string): string {
  return `relay-${createHash('sha256').update(relayVersionDirName).digest('hex').slice(0, 12)}`
}

/**
 * The whole hashed socket name is kept — shortening happens by replacing the
 * variable-length directory, never by truncating the hash, so two targets on one
 * host can never land on the same socket.
 */
export function shortRelaySocketPath(shortVersionDir: string, sockName: string): string {
  return `${shortVersionDir}/${sockName}`
}

const SHORT_DIR_MARKER = 'ORCA-RELAY-SHORT-SOCKET-DIR'

/**
 * Create (or adopt) the per-uid short socket directory and its version segment, and
 * print the segment's path.
 *
 * Validate before mutating, never the other way round: an unconditional `chmod` follows a
 * symlink, so a path planted by another user would have its *target's* mode rewritten before
 * the owner check could reject it. A fresh `mkdir` under `umask 077` already yields 0700 and
 * proves we own it, so the only path that adopts an existing entry is the one that first
 * proves — via `ls -ldn`, which reports the entry itself rather than what it points at — that
 * it is a real directory, owned by this uid, already 0700. Nothing else is touched.
 */
export function resolveShortRelaySocketDirCommand(versionSegment: string): string {
  return [
    'uid=$(id -u) || exit 1',
    `dir="${SHORT_RELAY_SOCKET_DIR_PREFIX}$uid"`,
    'umask 077',
    ...adoptOwnedDirectoryCommand('$dir'),
    // The version segment is validated the same way rather than trusted: `$dir` being
    // 0700 and ours does not prove what an earlier run left inside it still is.
    `ver="$dir/${versionSegment}"`,
    ...adoptOwnedDirectoryCommand('$ver'),
    `printf '%s %s\n' '${SHORT_DIR_MARKER}' "$ver"`
  ].join('\n')
}

function adoptOwnedDirectoryCommand(target: string): string[] {
  return [
    `if mkdir "${target}" 2>/dev/null; then`,
    '  :',
    'else',
    // Why the sub(): ls decorates the mode with a trailing marker for extended attributes (@),
    // ACLs (+) or an SELinux context (.), so an exact match would refuse a directory we own.
    `  entry=$(ls -ldn "${target}" 2>/dev/null | awk 'NR==1{sub(/[.@+]$/, "", $1); print $1" "$3}')`,
    '  case "$entry" in',
    '    "drwx------ $uid") ;;',
    '    *) exit 1 ;;',
    '  esac',
    'fi'
  ]
}

/** Tolerates login-shell banner noise ahead of the marker line. */
export function parseShortRelaySocketDir(output: string, versionSegment: string): string | null {
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(`${SHORT_DIR_MARKER} `)) {
      continue
    }
    const dir = trimmed.slice(SHORT_DIR_MARKER.length + 1).trim()
    if (
      dir.startsWith(`${SHORT_RELAY_SOCKET_DIR_PREFIX}`) &&
      dir.endsWith(`/${versionSegment}`) &&
      !/[\r\n]/.test(dir)
    ) {
      return dir
    }
  }
  return null
}
