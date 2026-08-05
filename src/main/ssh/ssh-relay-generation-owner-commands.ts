// Remote probes that prove which relay process owns a POSIX socket before anything signals it.
//
// Every command is POSIX `/bin/sh` and emits a fixed token vocabulary between sentinels, so an SSH
// login banner can never be mistaken for a result. Interpolated values are shell-escaped, and the
// command line is matched with `grep -Fxq` (fixed string, whole line) rather than a regex — there is
// no pattern to escape.
//
// What that match proves differs by platform, and the difference is real. On Linux the script reads
// /proc/<pid>/cmdline and splits on NUL, so a hit is a true argv element. On macOS/BSD the kernel
// has already flattened argv into a space-joined string by the time `ps -ww -o command=` sees it, so
// a hit is an exact whitespace-delimited token of that flattened line — the most any POSIX tool can
// recover there. Against the accident cases this guards (PID reuse, successor generations) both are
// equally strong: a recycled PID cannot spontaneously contain a 256-bit token. Deliberate same-user
// argv spoofing is outside the threat boundary — that actor can signal the process directly.
//
// The argv token is NOT by itself a process-start identity. That comes from a separate OS value
// (/proc/<pid>/stat field 22, else `ps -o lstart=`) which the reaper reads, then re-reads and
// re-compares inside the same remote command as the single SIGTERM.

import {
  isRelayGenerationToken,
  isRelaySocketIdentity,
  parseRelayOwnerManifest,
  relayOwnerManifestPath,
  relaySocketIdentity,
  RELAY_OWNER_MANIFEST_MAX_BYTES,
  type RelayOwnerManifest
} from '../../shared/relay-owner-manifest'
import { shellEscape } from './ssh-connection-utils'
import { randomBytes } from 'node:crypto'

const OWNER_START = '__ORCA_RELAY_OWNER__'
const OWNER_END = '__ORCA_RELAY_OWNER_END__'
// Why: the manifest is the one untrusted payload inside the frame, so every one of its lines is
// prefixed on the host. Without this, crafted content could forge probe fields or a second sentinel.
const MANIFEST_LINE_PREFIX = 'm:'
// Why: tokens no `stat` can emit, so they can never collide with a real dev:ino:ctime triple.
const SOCKET_UNUSABLE_MARKER = 'unusable'
const SOCKET_UNREADABLE_MARKER = 'unreadable'
const IDENTITY_START = '__ORCA_RELAY_OWNER_ID__'
const IDENTITY_END = '__ORCA_RELAY_OWNER_ID_END__'
const READY_START = '__ORCA_RELAY_RELAUNCH_READY__'
const READY_END = '__ORCA_RELAY_RELAUNCH_READY_END__'
const MAX_PID = 2 ** 31 - 1

/**
 * The probe answers two different questions at once, and they partition the state space differently:
 * "may we signal?" (only `owned` may) and "is this worth retrying?". Keeping the not-ours states
 * distinct is what stops a healthy successor from inheriting the pessimism the signal gate needs.
 */
export type RelayOwnerProbe =
  | { kind: 'owned'; manifest: RelayOwnerManifest; socketIdentity: string }
  /** No manifest at all: a legacy relay, or a successor between listen and publication. */
  | { kind: 'no-manifest'; socketIdentity: string }
  /** A file exists but the host refused it: symlink, wrong owner, wrong mode. Persistent. */
  | { kind: 'manifest-rejected' }
  /** Bytes present but unparseable. Publication is temp+rename, so this is corruption, not a tear. */
  | { kind: 'manifest-malformed' }
  /** Parses, but describes some other socket path entirely. Persistent. */
  | { kind: 'manifest-foreign' }
  /** Parses and names this path, but a different socket object now holds it — a successor. */
  | { kind: 'manifest-superseded'; socketIdentity: string }
  | { kind: 'socket-absent' }
  /** Something that is not a socket occupies the endpoint path. */
  | { kind: 'socket-unusable' }
  /** A socket is present but the host could not stat it — never treat this as absent. */
  | { kind: 'socket-unreadable' }
  | { kind: 'indeterminate' }

export type RelayGenerationIdentity =
  | { kind: 'match'; startToken: string }
  | { kind: 'mismatch' }
  | { kind: 'gone' }
  | { kind: 'indeterminate' }

export type RelayGenerationTerminateResult = 'signalled' | 'mismatch' | 'gone' | 'indeterminate'
export type RelayRelaunchReadiness = 'absent' | 'present' | 'unknown'

function relayEndpointParentDir(sockPath: string): string {
  return sockPath.slice(0, sockPath.lastIndexOf('/')) || '/'
}

export function createRelayGenerationToken(): string {
  return randomBytes(32).toString('hex')
}

export function relayOwnerProbeCommand(sockPath: string): string {
  const sock = shellEscape(sockPath)
  const manifest = shellEscape(relayOwnerManifestPath(sockPath))
  return [
    `orca_sock=${sock}`,
    `orca_dir=${shellEscape(relayEndpointParentDir(sockPath))}`,
    `orca_manifest=${manifest}`,
    `printf '%s\\n' ${shellEscape(OWNER_START)}`,
    socketIdentityScript(),
    'printf \'sockid=%s\\n\' "$orca_sockid"',
    manifestAcceptanceScript(),
    'if [ -n "$orca_ok" ]; then',
    "printf 'manifest=present\\n';",
    // Why: awk, not sed — BSD sed leaves an unterminated final line, which would glue the closing
    // sentinel onto the last manifest line and make every probe unreadable.
    `head -c ${RELAY_OWNER_MANIFEST_MAX_BYTES} "$orca_manifest" 2>/dev/null | awk ${shellEscape(`{print "${MANIFEST_LINE_PREFIX}" $0}`)};`,
    'elif [ -e "$orca_manifest" ] || [ -L "$orca_manifest" ]; then',
    "printf 'manifest=rejected\\n';",
    'else',
    "printf 'manifest=missing\\n';",
    'fi',
    `printf '%s\\n' ${shellEscape(OWNER_END)}`
  ].join('\n')
}

// Why: device + inode + change time, the same triple the relay itself uses to decide it still owns
// the path. Inode alone is recycled, so a stale manifest could otherwise claim a successor's socket.
function socketIdentityScript(): string {
  return [
    'orca_sockid=',
    // Why: `[ -S ]` is false both for "nothing here" and for "cannot look". Without proving the
    // parent is searchable first, an unreadable path reports as absent — and absent authorizes a
    // relaunch straight over a live relay.
    'if [ ! -d "$orca_dir" ] || [ ! -x "$orca_dir" ]; then',
    `orca_sockid=${SOCKET_UNREADABLE_MARKER};`,
    'elif [ -S "$orca_sock" ] && [ ! -L "$orca_sock" ]; then',
    'orca_sockid=$(stat -c %d:%i:%Z "$orca_sock" 2>/dev/null || stat -f %d:%i:%c "$orca_sock" 2>/dev/null);',
    // Why: an empty result here means a live socket the host could not stat, not an empty path.
    // Reporting it as absent would authorize a relaunch straight over a listening relay.
    `if [ -z "$orca_sockid" ]; then orca_sockid=${SOCKET_UNREADABLE_MARKER}; fi;`,
    // Why: a symlink or a plain file at the socket path is not "nothing here". Reporting it as
    // absent would let recovery relaunch, rotating the endpoint credential out from under whatever
    // the link points at. Name the state so the client refuses instead.
    'elif [ -e "$orca_sock" ] || [ -L "$orca_sock" ]; then',
    `orca_sockid=${SOCKET_UNUSABLE_MARKER};`,
    'fi'
  ].join('\n')
}

// Why: type, ownership and exact mode 0600 are the properties a same-user relay guarantees;
// anything else (symlink, directory, group-readable) is treated as unusable rather than parsed.
function manifestAcceptanceScript(): string {
  return [
    'orca_user=$(id -un 2>/dev/null)',
    'orca_ok=',
    'if [ -n "$orca_user" ]; then',
    'orca_ok=$(find "$orca_manifest" -maxdepth 0 -type f -user "$orca_user" -perm 600 -print 2>/dev/null);',
    'fi'
  ].join('\n')
}

export function relayGenerationIdentityCommand(pid: number, generation: string): string {
  return identityScript(pid, generation, null)
}

export function relayGenerationTerminateCommand(
  pid: number,
  generation: string,
  startToken: string
): string {
  if (startToken.length === 0 || /[\r\n]/.test(startToken)) {
    throw new Error('Relay generation start token must be a non-empty single-line value')
  }
  return identityScript(pid, generation, startToken)
}

function identityScript(pid: number, generation: string, startToken: string | null): string {
  assertPid(pid)
  assertGeneration(generation)
  const lines = [
    `orca_pid=${shellEscape(String(pid))}`,
    `orca_gen=${shellEscape(generation)}`,
    ...(startToken === null ? [] : [`orca_want_start=${shellEscape(startToken)}`]),
    `printf '%s\\n' ${shellEscape(IDENTITY_START)}`,
    'orca_state=gone',
    'orca_start=',
    livenessScript(),
    argvMatchScript(),
    ...(startToken === null ? [] : [terminateScript()]),
    'printf \'state=%s\\nstart=%s\\n\' "$orca_state" "$orca_start"',
    `printf '%s\\n' ${shellEscape(IDENTITY_END)}`
  ]
  return lines.join('\n')
}

// Why: `kill -0` failing is not proof of exit — EPERM means a live process this user cannot signal.
// Only a missing /proc entry or a `ps` miss proves the pid is gone; anything else stays unknown.
function livenessScript(): string {
  return [
    'if kill -0 "$orca_pid" 2>/dev/null; then orca_alive=yes;',
    'elif [ -d /proc ] && [ ! -d "/proc/$orca_pid" ]; then orca_alive=no;',
    'elif command -v ps >/dev/null 2>&1; then',
    'if ps -p "$orca_pid" >/dev/null 2>&1; then orca_alive=other; else orca_alive=no; fi;',
    'else orca_alive=unknown;',
    'fi'
  ].join('\n')
}

function argvMatchScript(): string {
  return [
    'if [ "$orca_alive" = yes ]; then',
    'orca_cmd=;',
    'if [ -r "/proc/$orca_pid/cmdline" ]; then',
    "orca_cmd=$(tr '\\000' '\\n' < \"/proc/$orca_pid/cmdline\" 2>/dev/null);",
    'fi;',
    'if [ -z "$orca_cmd" ]; then',
    "orca_cmd=$(ps -ww -o command= -p \"$orca_pid\" 2>/dev/null | tr ' ' '\\n');",
    'fi;',
    'if [ -z "$orca_cmd" ]; then orca_state=unknown;',
    'elif printf \'%s\\n\' "$orca_cmd" | grep -Fxq -e "$orca_gen" && printf \'%s\\n\' "$orca_cmd" | grep -Fxq -e \'relay.js\'; then',
    startTokenScript(),
    'else orca_state=mismatch;',
    'fi;',
    'elif [ "$orca_alive" = no ]; then orca_state=gone;',
    'else orca_state=unknown;',
    'fi'
  ].join('\n')
}

// Why: the reaper derives the start identity itself and compares its own two readings, so the
// relay never has to shell out for a platform-specific value it cannot compute portably.
function startTokenScript(): string {
  return [
    'if [ -r "/proc/$orca_pid/stat" ]; then',
    "orca_start=linux:$(sed -n '1s/.*) //p' \"/proc/$orca_pid/stat\" 2>/dev/null | awk '{print $20}');",
    'else',
    "orca_start=ps:$(ps -o lstart= -p \"$orca_pid\" 2>/dev/null | tr -s ' ' | sed 's/^ *//;s/ *$//');",
    'fi;',
    'case "$orca_start" in',
    'linux:|ps:) orca_state=unknown; orca_start=; ;;',
    '*) orca_state=match; ;;',
    'esac;'
  ].join('\n')
}

function terminateScript(): string {
  return [
    'if [ "$orca_state" = match ] && [ "$orca_start" = "$orca_want_start" ]; then',
    'if kill -TERM "$orca_pid" 2>/dev/null; then orca_state=signalled; else orca_state=unknown; fi;',
    'elif [ "$orca_state" = match ]; then orca_state=mismatch;',
    'fi'
  ].join('\n')
}

/**
 * Non-mutating proof that nothing occupies the socket pathname, used as the relaunch gate after the
 * old generation is confirmed gone.
 *
 * Why nothing is removed here: once the owner has exited, no identity can authorize an unlink. The
 * socket identity is dev:ino:ctime at whole-second granularity, and a successor binding the same
 * path within that second reproduces it exactly — so a conditional `rm` could delete a live
 * successor's socket. A relay releases its own socket on exit, so an empty pathname is the only
 * signal the parent needs, and refusing to relaunch is the safe answer to anything else.
 */
export function relayRelaunchReadinessCommand(sockPath: string): string {
  if (!sockPath.startsWith('/')) {
    throw new Error(`Relay relaunch readiness needs an absolute POSIX socket path: ${sockPath}`)
  }
  return [
    `orca_sock=${shellEscape(sockPath)}`,
    `orca_dir=${shellEscape(relayEndpointParentDir(sockPath))}`,
    `printf '%s\\n' ${shellEscape(READY_START)}`,
    // Why: closed by default — every branch below has to earn 'absent'.
    'orca_ready=unknown',
    // Why: `[ -e ]` is false both for "nothing here" and for "cannot look" — an unsearchable parent
    // or a non-directory component. Prove the directory is searchable first so an unreadable path
    // can never be reported as an empty one.
    'if [ -d "$orca_dir" ] && [ -x "$orca_dir" ]; then',
    // Why: -L as well as -e. A dangling symlink is still a node, and relaunching over it would hand
    // the endpoint credential to whatever the link later resolves to.
    'if [ -e "$orca_sock" ] || [ -L "$orca_sock" ]; then orca_ready=present;',
    'else orca_ready=absent;',
    'fi;',
    'fi',
    'printf \'ready=%s\\n\' "$orca_ready"',
    `printf '%s\\n' ${shellEscape(READY_END)}`
  ].join('\n')
}

export function parseRelayOwnerProbeOutput(output: string, sockPath: string): RelayOwnerProbe {
  const body = sentinelBody(output, OWNER_START, OWNER_END)
  if (body === null) {
    return { kind: 'indeterminate' }
  }
  const socketIdentity = fieldValue(body, 'sockid=')
  const manifestState = fieldValue(body, 'manifest=')
  if (socketIdentity === null || manifestState === null) {
    return { kind: 'indeterminate' }
  }
  if (socketIdentity === '') {
    return { kind: 'socket-absent' }
  }
  if (socketIdentity === SOCKET_UNUSABLE_MARKER) {
    return { kind: 'socket-unusable' }
  }
  if (socketIdentity === SOCKET_UNREADABLE_MARKER) {
    return { kind: 'socket-unreadable' }
  }
  if (!isRelaySocketIdentity(socketIdentity)) {
    return { kind: 'indeterminate' }
  }
  if (manifestState === 'missing') {
    return { kind: 'no-manifest', socketIdentity }
  }
  if (manifestState === 'rejected') {
    return { kind: 'manifest-rejected' }
  }
  if (manifestState !== 'present') {
    return { kind: 'indeterminate' }
  }
  // Why: only prefixed lines are manifest bytes; anything else in the frame is host output the
  // manifest must not be able to forge.
  const manifestText = body
    .filter((line) => line.startsWith(MANIFEST_LINE_PREFIX))
    .map((line) => line.slice(MANIFEST_LINE_PREFIX.length))
    .join('\n')
  const manifest = parseRelayOwnerManifest(`${manifestText}\n`)
  if (manifest === null) {
    return { kind: 'manifest-malformed' }
  }
  if (manifest.socketPath !== sockPath) {
    return { kind: 'manifest-foreign' }
  }
  // Why: the relay publishes only after it owns the socket and re-stats it, and nothing chmods a
  // socket after listen — so a differing identity means a different socket object holds this path,
  // i.e. a successor, not clock skew.
  if (relaySocketIdentity(manifest) !== socketIdentity) {
    return { kind: 'manifest-superseded', socketIdentity }
  }
  return { kind: 'owned', manifest, socketIdentity }
}

export function parseRelayGenerationIdentityOutput(output: string): RelayGenerationIdentity {
  const body = sentinelBody(output, IDENTITY_START, IDENTITY_END)
  const state = body === null ? null : fieldValue(body, 'state=')
  const startToken = body === null ? null : fieldValue(body, 'start=')
  if (state === 'mismatch') {
    return { kind: 'mismatch' }
  }
  if (state === 'gone') {
    return { kind: 'gone' }
  }
  if (state === 'match' && startToken !== null && startToken !== '') {
    return { kind: 'match', startToken }
  }
  return { kind: 'indeterminate' }
}

export function parseRelayGenerationTerminateOutput(
  output: string
): RelayGenerationTerminateResult {
  const body = sentinelBody(output, IDENTITY_START, IDENTITY_END)
  const state = body === null ? null : fieldValue(body, 'state=')
  if (state === 'signalled' || state === 'mismatch' || state === 'gone') {
    return state
  }
  return 'indeterminate'
}

export function parseRelayRelaunchReadinessOutput(output: string): RelayRelaunchReadiness {
  const body = sentinelBody(output, READY_START, READY_END)
  const state = body === null ? null : fieldValue(body, 'ready=')
  // Why: anything unrecognised is 'unknown', never 'absent'. Unparseable output must not read as
  // permission to relaunch.
  return state === 'absent' || state === 'present' ? state : 'unknown'
}

function sentinelBody(output: string, start: string, end: string): string[] | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim())
  const startIndex = lines.lastIndexOf(start)
  if (startIndex < 0) {
    return null
  }
  const endIndex = lines.indexOf(end, startIndex + 1)
  return endIndex < 0 ? null : lines.slice(startIndex + 1, endIndex)
}

function fieldValue(body: string[], prefix: string): string | null {
  const line = body.find((candidate) => candidate.startsWith(prefix))
  return line === undefined ? null : line.slice(prefix.length)
}

function assertPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PID) {
    throw new Error(`Relay owner pid must be a positive integer below ${MAX_PID}: ${pid}`)
  }
}

function assertGeneration(generation: string): void {
  if (!isRelayGenerationToken(generation)) {
    throw new Error('Relay generation token must be 64 lowercase hex characters')
  }
}
