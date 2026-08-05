// Remote probes that prove which relay process owns a POSIX socket before anything signals it.
//
// Every command is POSIX `/bin/sh` and emits a fixed token vocabulary between sentinels, so an SSH
// login banner can never be mistaken for a result. Interpolated values are shell-escaped, and argv
// matching uses `grep -Fxq` (fixed string, whole line) rather than a regex — there is no pattern to
// escape, and a match means an exact argv element, not a substring.

import {
  isRelayGenerationToken,
  isRelaySocketIdentity,
  parseRelayOwnerManifest,
  relayOwnerManifestPath,
  relaySocketIdentity,
  RELAY_OWNER_MANIFEST_HEADER,
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
// Why: a token no `stat` can emit, so it can never collide with a real dev:ino:ctime triple.
const SOCKET_UNUSABLE_MARKER = 'unusable'
const IDENTITY_START = '__ORCA_RELAY_OWNER_ID__'
const IDENTITY_END = '__ORCA_RELAY_OWNER_ID_END__'
const CLEANUP_START = '__ORCA_RELAY_OWNER_CLEANUP__'
const CLEANUP_END = '__ORCA_RELAY_OWNER_CLEANUP_END__'
const MAX_PID = 2 ** 31 - 1

export type RelayOwnerProbe =
  | { kind: 'owned'; manifest: RelayOwnerManifest; socketIdentity: string }
  | { kind: 'no-manifest' }
  | { kind: 'unusable-manifest' }
  | { kind: 'socket-absent' }
  | { kind: 'socket-unusable' }
  | { kind: 'indeterminate' }

export type RelayGenerationIdentity =
  | { kind: 'match'; startToken: string }
  | { kind: 'mismatch' }
  | { kind: 'gone' }
  | { kind: 'indeterminate' }

export type RelayGenerationTerminateResult = 'signalled' | 'mismatch' | 'gone' | 'indeterminate'
export type RelayGenerationCleanupResult = 'clean' | 'foreign' | 'failed' | 'indeterminate'

export function createRelayGenerationToken(): string {
  return randomBytes(32).toString('hex')
}

export function relayOwnerProbeCommand(sockPath: string): string {
  const sock = shellEscape(sockPath)
  const manifest = shellEscape(relayOwnerManifestPath(sockPath))
  return [
    `orca_sock=${sock}`,
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
    'if [ -S "$orca_sock" ] && [ ! -L "$orca_sock" ]; then',
    'orca_sockid=$(stat -c %d:%i:%Z "$orca_sock" 2>/dev/null || stat -f %d:%i:%c "$orca_sock" 2>/dev/null);',
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

export function relayGenerationCleanupCommand(
  sockPath: string,
  socketIdentity: string,
  generation: string
): string {
  if (!isRelaySocketIdentity(socketIdentity)) {
    throw new Error(`Relay socket identity must be dev:inode:ctime integers: ${socketIdentity}`)
  }
  assertGeneration(generation)
  return [
    `orca_sock=${shellEscape(sockPath)}`,
    `orca_manifest=${shellEscape(relayOwnerManifestPath(sockPath))}`,
    `orca_want_sockid=${shellEscape(socketIdentity)}`,
    `orca_want_gen=${shellEscape(generation)}`,
    `printf '%s\\n' ${shellEscape(CLEANUP_START)}`,
    'orca_res=clean',
    socketIdentityScript(),
    // Why: a socket still at this path must prove it is the one the terminated generation owned.
    'if [ -e "$orca_sock" ] || [ -L "$orca_sock" ]; then',
    '[ "$orca_sockid" = "$orca_want_sockid" ] || orca_res=foreign;',
    'fi',
    manifestAcceptanceScript(),
    'orca_gen=',
    'if [ -n "$orca_ok" ]; then',
    // Why: read the generation only from a file that starts with the manifest header, so a stray
    // `generation=` line in some other file can never authorize a removal.
    `orca_head=$(head -c ${RELAY_OWNER_MANIFEST_MAX_BYTES} "$orca_manifest" 2>/dev/null);`,
    `if [ "$(printf '%s\\n' "$orca_head" | sed -n 1p)" = ${shellEscape(RELAY_OWNER_MANIFEST_HEADER)} ]; then`,
    "orca_gen=$(printf '%s\\n' \"$orca_head\" | sed -n 's/^generation=//p' | head -n 1);",
    'fi;',
    'fi',
    // Why: with the socket still present, an absent or foreign manifest is not proof of ownership —
    // it is exactly the manifest-less successor case, so refuse rather than unlink a live relay.
    'if [ "$orca_res" = clean ] && [ "$orca_gen" != "$orca_want_gen" ]; then',
    'if [ -S "$orca_sock" ] || [ -e "$orca_manifest" ] || [ -L "$orca_manifest" ]; then orca_res=foreign; fi;',
    'fi',
    'if [ "$orca_res" = clean ]; then',
    'rm -f "$orca_sock" "$orca_manifest" 2>/dev/null;',
    'if [ -e "$orca_sock" ] || [ -e "$orca_manifest" ]; then orca_res=failed; fi;',
    'fi',
    'printf \'cleanup=%s\\n\' "$orca_res"',
    `printf '%s\\n' ${shellEscape(CLEANUP_END)}`
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
  if (!isRelaySocketIdentity(socketIdentity)) {
    return { kind: 'indeterminate' }
  }
  if (manifestState === 'missing') {
    return { kind: 'no-manifest' }
  }
  if (manifestState === 'rejected') {
    return { kind: 'unusable-manifest' }
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
  if (
    manifest === null ||
    manifest.socketPath !== sockPath ||
    relaySocketIdentity(manifest) !== socketIdentity
  ) {
    return { kind: 'unusable-manifest' }
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

export function parseRelayGenerationCleanupOutput(output: string): RelayGenerationCleanupResult {
  const body = sentinelBody(output, CLEANUP_START, CLEANUP_END)
  const state = body === null ? null : fieldValue(body, 'cleanup=')
  if (state === 'clean' || state === 'foreign' || state === 'failed') {
    return state
  }
  return 'indeterminate'
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
