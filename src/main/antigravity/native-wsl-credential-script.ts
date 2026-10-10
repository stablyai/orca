import { TextDecoder } from 'node:util'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import type { WslCommand } from '../wsl/wsl-runner'
import type { ResolvedAntigravityWslTarget } from './native-wsl-account-target'

const MAX_CREDENTIAL_BYTES = 64 * 1024
export const MAX_WSL_CREDENTIAL_TRANSPORT_BYTES = 192 * 1024
function decodeBytes(value: string): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid WSL credential protocol')
  }
  const bytes = Buffer.from(value, 'base64')
  if (
    bytes.length === 0 ||
    bytes.length > MAX_CREDENTIAL_BYTES ||
    bytes.toString('base64') !== value
  ) {
    throw new Error('Invalid WSL credential protocol')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error('Invalid WSL credential protocol')
  }
}
export type AntigravityWslCredentialReply =
  | { status: 'missing' }
  | { status: 'present'; contents: string }
export function decodeAntigravityWslReply(
  output: string,
  nonce: string
): AntigravityWslCredentialReply {
  const lines = output.split('\n')
  if (
    Buffer.byteLength(output) > MAX_WSL_CREDENTIAL_TRANSPORT_BYTES ||
    !/^[a-z0-9]{1,64}$/.test(nonce) ||
    lines.length !== 4 ||
    lines[0] !== `ORCA_AGY_WSL_REPLY_V1 ${nonce}` ||
    lines[3] !== ''
  ) {
    throw new Error('Invalid WSL credential protocol')
  }
  if (lines[1] === 'missing' && lines[2] === '') {
    return { status: 'missing' }
  }
  if (lines[1] !== 'present') {
    throw new Error('Invalid WSL credential protocol')
  }
  return { status: lines[1], contents: decodeBytes(lines[2]) }
}

const READ_SCRIPT = String.raw`
set -eu
token=$1; before=$2
exec 8< "$token"
[ "$(stat -L -c '%d:%i:%u:%a:%h:%s:%y:%z' /proc/self/fd/8)" = "$before" ] || exit 73
[ "$(stat -L -c %F /proc/self/fd/8)" = 'regular file' ] || exit 77
data=$(head -c 65537 <&8 | base64 -w 0)
[ ! -L "$token" ] && [ "$(stat -c '%d:%i:%u:%a:%h:%s:%y:%z' -- "$token")" = "$before" ] || exit 73
[ "$(stat -L -c '%d:%i:%u:%a:%h:%s:%y:%z' /proc/self/fd/8)" = "$before" ] || exit 73
exec 8<&-
[ "${'$'}{#data}" -le 87384 ] || exit 77
printf %s "$data"
`

const SCRIPT = String.raw`
set -eu
PATH=/usr/bin:/bin; LC_ALL=C; export PATH LC_ALL
umask 077
fail() { exit "$1"; }
action=$1; distro=$2; uid=$3; home=$4; nonce=$5; budget=$6
[ "$action" = read ] || fail 65
for tool in id stat base64 head readlink tr date dirname timeout sh; do
  command -v "$tool" >/dev/null 2>&1 || fail 69
done
case "$budget" in ''|*[!0-9]*) fail 65 ;; esac
[ "$budget" -gt 0 ] || fail 75
deadline=$(( $(date +%s) + budget ))
[ "$(printf %s "${'$'}{WSL_DISTRO_NAME:-}" | tr '[:upper:]' '[:lower:]')" = "$distro" ] || fail 74
[ "$(id -u)" = "$uid" ] || fail 74
[ "$(readlink -e -- "$home")" = "$home" ] || fail 74
check_time() { [ "$(date +%s)" -lt "$deadline" ] || fail 75; }
check_dir() {
  [ ! -L "$1" ] && [ -d "$1" ] || fail 77
  owner=$(stat -c %u -- "$1")
  [ "$owner" = "$uid" ] || [ "$owner" = 0 ] || fail 77
  mode=$(stat -c %a -- "$1")
  [ $((0$mode & 0022)) -eq 0 ] || fail 77
  case "$(stat -f -c %T -- "$1")" in 9p|drvfs|fuseblk|fuse.*|vfat|msdos) fail 77 ;; esac
}
[ "$(stat -c %u -- "$home")" = "$uid" ] || fail 77
current=$home
while :; do
  check_dir "$current"
  [ "$current" = / ] && break
  current=$(dirname -- "$current")
done
root=$home/.gemini
parent=$root/antigravity-cli
token=$parent/antigravity-oauth-token
reply_missing() { printf 'ORCA_AGY_WSL_REPLY_V1 %s\nmissing\n\n' "$nonce"; }
for directory in "$root" "$parent"; do
  if [ ! -e "$directory" ] && [ ! -L "$directory" ]; then
    reply_missing; exit 0
  fi
  [ "$(stat -c %u -- "$directory")" = "$uid" ] || fail 77
  check_dir "$directory"
done
check_file() {
  [ ! -L "$1" ] && [ -f "$1" ] || fail 77
  [ "$(stat -c '%u:%a:%h' -- "$1")" = "$uid:600:1" ] || fail 77
  [ "$(stat -c %s -- "$1")" -le 65536 ] || fail 77
}
check_time
read_token() {
  present=missing; data=''
  if [ ! -e "$token" ] && [ ! -L "$token" ]; then return; fi
  check_file "$token"
  before=$(stat -c '%d:%i:%u:%a:%h:%s:%y:%z' -- "$token")
  # A read-only open cannot recreate a logout-deleted token; timeout bounds FIFO races.
  remaining=$((deadline - $(date +%s)))
  [ "$remaining" -gt 0 ] || fail 75
  data=$(timeout --kill-after=1s "${'$'}{remaining}s" sh -c ${quotePosixShell(READ_SCRIPT)} -- "$token" "$before") || fail "$?"
  present=present
}
read_token
printf 'ORCA_AGY_WSL_REPLY_V1 %s\n%s\n%s\n' "$nonce" "$present" "$data"
`

export function buildAntigravityWslCredentialCommand(
  action: 'read',
  authority: ResolvedAntigravityWslTarget,
  nonce: string,
  deadline = Date.now() + 15_000
): WslCommand {
  return {
    script: SCRIPT,
    args: [
      action,
      authority.distro.toLowerCase(),
      String(authority.uid),
      authority.canonicalHome,
      nonce,
      String(Math.max(1, Math.ceil((deadline - Date.now()) / 1000)))
    ]
  }
}
