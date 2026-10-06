import type { WslCommand } from '../wsl/wsl-runner'
import type { ResolvedAntigravityWslTarget } from './native-wsl-account-target'

const SCRIPT = String.raw`
set -eu
PATH=/usr/bin:/bin; LC_ALL=C; export PATH LC_ALL
umask 077
fail() { exit "$1"; }
for tool in id stat base64 cmp head mktemp flock mv sync readlink tr date chmod mkdir rm dirname find; do
  command -v "$tool" >/dev/null 2>&1 || fail 69
done
action=$1; distro=$2; uid=$3; home=$4; nonce=$5; deadline=$6
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
    if [ "$action" = read ]; then reply_missing; exit 0; fi
    check_time; mkdir -m 700 -- "$directory" || fail 77
  fi
  [ "$(stat -c %u -- "$directory")" = "$uid" ] || fail 77
  check_dir "$directory"
done
check_file() {
  [ ! -L "$1" ] && [ -f "$1" ] || fail 77
  [ "$(stat -c '%u:%a:%h' -- "$1")" = "$uid:600:1" ] || fail 77
  [ "$(stat -c %s -- "$1")" -le 65536 ] || fail 77
}
lock=$parent/.orca-antigravity-account.lock
if [ ! -e "$lock" ] && [ ! -L "$lock" ]; then
  (set -C; : > "$lock") 2>/dev/null || [ -e "$lock" ] || fail 77
fi
check_file "$lock"
lock_meta=$(stat -c '%d:%i:%u:%a:%h' -- "$lock")
exec 9<> "$lock"
[ "$(stat -L -c '%d:%i:%u:%a:%h' /proc/self/fd/9)" = "$lock_meta" ] || fail 77
[ "$(stat -L -c %F /proc/self/fd/9)" = 'regular empty file' ] || [ "$(stat -L -c %F /proc/self/fd/9)" = 'regular file' ] || fail 77
flock -w 2 9 || fail 76
check_time
count=0
while [ "$count" -lt 16 ]; do
  orphan=$(find "$parent" -mindepth 1 -maxdepth 1 -type d -name '.orca-agy-stage.*' -print -quit)
  [ -n "$orphan" ] || break
  suffix=${'$'}{orphan##*/.orca-agy-stage.}
  case "$suffix" in *[!a-zA-Z0-9]*|'') break ;; esac
  [ "${'$'}{#suffix}" -eq 12 ] || break
  [ ! -L "$orphan" ] && [ "$(stat -c '%u:%a' -- "$orphan")" = "$uid:700" ] || break
  safe=yes
  for child in "$orphan"/* "$orphan"/.[!.]* "$orphan"/..?*; do
    [ -e "$child" ] || [ -L "$child" ] || continue
    case "$child" in "$orphan/token"|"$orphan/expected") ;; *) safe=no; break ;; esac
    [ ! -L "$child" ] && [ -f "$child" ] && [ "$(stat -c '%u:%a:%h' -- "$child")" = "$uid:600:1" ] || { safe=no; break; }
  done
  [ "$safe" = yes ] || break
  rm -rf -- "$orphan"
  count=$((count + 1))
done
staging=''
cleanup() { [ -z "$staging" ] || rm -rf -- "$staging"; }
trap cleanup EXIT
trap 'exit 75' HUP INT TERM
read_token() {
  present=missing; data=''
  if [ ! -e "$token" ] && [ ! -L "$token" ]; then return; fi
  check_file "$token"
  before=$(stat -c '%d:%i:%u:%a:%h:%s:%y:%z' -- "$token")
  # O_RDWR prevents a raced FIFO open from blocking before descriptor validation.
  exec 8<> "$token"
  [ "$(stat -L -c '%d:%i:%u:%a:%h:%s:%y:%z' /proc/self/fd/8)" = "$before" ] || fail 73
  [ "$(stat -L -c %F /proc/self/fd/8)" = 'regular file' ] || fail 77
  data=$(head -c 65537 <&8 | base64 -w 0)
  [ ! -L "$token" ] && [ "$(stat -c '%d:%i:%u:%a:%h:%s:%y:%z' -- "$token")" = "$before" ] || fail 73
  [ "$(stat -L -c '%d:%i:%u:%a:%h:%s:%y:%z' /proc/self/fd/8)" = "$before" ] || fail 73
  exec 8>&-
  [ "${'$'}{#data}" -le 87384 ] || fail 77
  present=present
}
read_token
if [ "$action" = read ]; then
  printf 'ORCA_AGY_WSL_REPLY_V1 %s\n%s\n%s\n' "$nonce" "$present" "$data"
  exit 0
fi
[ "$action" = write ] || fail 65
IFS= read -r header || fail 65
IFS= read -r expected || fail 65
IFS= read -r next || fail 65
if IFS= read -r extra; then fail 65; fi
[ "$header" = ORCA_AGY_WSL_INPUT_V1 ] || fail 65
[ "${'$'}{#expected}" -le 87384 ] && [ "${'$'}{#next}" -le 87384 ] || fail 65
[ "$expected" != missing ] || [ "$present" = missing ] || fail 73
[ "$expected" = missing ] || [ "$expected" = "$data" ] || fail 73
staging=$(mktemp -d "$parent/.orca-agy-stage.XXXXXXXXXXXX") || fail 77
check_dir "$staging"
printf %s "$next" | base64 -d > "$staging/token" 2>/dev/null || fail 65
check_file "$staging/token"
[ "$(base64 -w 0 "$staging/token")" = "$next" ] || fail 65
if [ "$expected" != missing ]; then
  printf %s "$expected" | base64 -d > "$staging/expected" 2>/dev/null || fail 65
  check_file "$staging/expected"
  [ "$(base64 -w 0 "$staging/expected")" = "$expected" ] || fail 65
fi
sync -f "$staging/token" || fail 74
read_token
if [ "$expected" = missing ]; then [ "$present" = missing ] || fail 73
else [ "$present" = present ] && [ "$expected" = "$data" ] && cmp -s -- "$staging/expected" "$token" || fail 73
fi
check_dir "$parent"; check_time
mv -T -- "$staging/token" "$token" || fail 74
sync -f "$parent" || fail 74
read_token
[ "$present" = present ] && [ "$data" = "$next" ] || fail 73
printf 'ORCA_AGY_WSL_REPLY_V1 %s\nwritten\n%s\n' "$nonce" "$data"
`

export function buildAntigravityWslCredentialCommand(
  action: 'read' | 'write',
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
      String(Math.floor(deadline / 1000))
    ]
  }
}
