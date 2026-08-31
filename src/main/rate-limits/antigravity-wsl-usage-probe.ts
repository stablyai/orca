import { runWslProcess } from '../wsl/wsl-runner'
import { createWslProcessGroupTermination } from '../git/wsl-process-group-termination'

const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_CAPTURE_BYTES = MAX_RESPONSE_BYTES + 64 * 1024

export const ANTIGRAVITY_WSL_PROBE_SCRIPT = String.raw`
set -u
log_dir="$HOME/.gemini/antigravity-cli/log"
proc_root=${'$'}{ORCA_AGY_PROC_ROOT:-/proc}
if [ ! -d "$log_dir" ]; then
  printf 'ORCA_AGY_NOT_RUNNING'
  exit 0
fi
if ! command -v curl >/dev/null 2>&1 || ! command -v head >/dev/null 2>&1 || ! command -v getconf >/dev/null 2>&1 || ! command -v stat >/dev/null 2>&1; then
  printf 'ORCA_AGY_UNVERIFIABLE'
  exit 0
fi
clock_ticks=$(getconf CLK_TCK 2>/dev/null) || {
  printf 'ORCA_AGY_UNVERIFIABLE'
  exit 0
}
boot_time=$(sed -n 's/^btime //p' "$proc_root/stat" 2>/dev/null | sed -n '1p')
case "$clock_ticks:$boot_time" in
  *[!0-9:]*|0:*|*:)
    printf 'ORCA_AGY_UNVERIFIABLE'
    exit 0
    ;;
esac
candidates=$(find "$log_dir" -maxdepth 1 -type f -name 'cli-*.log' -print 2>/dev/null | sort -r | sed -n '1,12p')
if [ -z "$candidates" ]; then
  printf 'ORCA_AGY_NOT_RUNNING'
  exit 0
fi
response_dir=$(mktemp -d "${'$'}{TMPDIR:-/tmp}/orca-agy-quota.XXXXXX") || {
  printf 'ORCA_AGY_UNVERIFIABLE'
  exit 0
}
response_file="$response_dir/response"
overflow_file="$response_dir/overflow"
status_file="$response_dir/status"
curl_code_file="$response_dir/curl-code"
cleanup() {
  rm -f "$response_file" "$overflow_file" "$status_file" "$curl_code_file"
  rmdir "$response_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' HUP INT TERM
found_live=0
while IFS= read -r log_file; do
  [ -n "$log_file" ] || continue
  log_head=$(dd if="$log_file" bs=8192 count=1 2>/dev/null) || continue
  pid=$(printf '%s\n' "$log_head" | sed -n 's/.*Starting language server process with pid \([0-9][0-9]*\).*/\1/p' | sed -n '1p')
  [ -n "$pid" ] || continue
  kill -0 "$pid" 2>/dev/null || continue
  process_name=''
  IFS= read -r process_name < "$proc_root/$pid/comm" || continue
  [ "$process_name" = 'agy' ] || continue
  proc_stat=''
  IFS= read -r proc_stat < "$proc_root/$pid/stat" || continue
  proc_fields=${'$'}{proc_stat##*) }
  set -- $proc_fields
  [ "$#" -ge 20 ] || continue
  shift 19
  start_ticks=$1
  case "$start_ticks" in ''|*[!0-9]*) continue ;; esac
  process_started_at=$((boot_time + start_ticks / clock_ticks))
  log_updated_at=$(stat -c %Y "$log_file" 2>/dev/null) || continue
  case "$log_updated_at" in ''|*[!0-9]*) continue ;; esac
  [ "$process_started_at" -le "$((log_updated_at + 2))" ] || continue
  found_live=1
  http_port=$(printf '%s\n' "$log_head" | sed -n 's/.*random port at \([0-9][0-9]*\) for HTTP$/\1/p' | sed -n '1p')
  https_port=$(printf '%s\n' "$log_head" | sed -n 's/.*random port at \([0-9][0-9]*\) for HTTPS.*/\1/p' | sed -n '1p')
  for target in "http:$http_port" "https:$https_port"; do
    scheme=${'$'}{target%%:*}
    port=${'$'}{target#*:}
    [ -n "$port" ] || continue
    : > "$response_file"
    : > "$overflow_file"
    : > "$status_file"
    : > "$curl_code_file"
    insecure=''
    [ "$scheme" = 'https' ] && insecure='--insecure'
    (
      curl --silent --show-error $insecure --connect-timeout 2.5 --max-time 2.5 \
        --output /dev/fd/3 --write-out '%{http_code}' \
        --header 'content-type: application/json' --header 'connect-protocol-version: 1' \
        --request POST --data '{}' \
        "$scheme://127.0.0.1:$port/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary" \
        3>&1 > "$status_file" 2>/dev/null
      printf '%s' "$?" > "$curl_code_file"
    ) | {
      head -c 1048576 > "$response_file"
      dd bs=1 count=1 of="$overflow_file" 2>/dev/null
    }
    reader_code=$?
    curl_code=$(cat "$curl_code_file")
    [ -n "$curl_code" ] || curl_code=1
    if [ -s "$overflow_file" ] || [ "$curl_code" -eq 63 ]; then
      printf 'ORCA_AGY_RESPONSE_TOO_LARGE'
      exit 0
    fi
    if [ "$curl_code" -eq 0 ] && [ "$reader_code" -eq 0 ]; then
      status=$(cat "$status_file")
      case "$status" in [0-9][0-9][0-9]) ;; *) continue ;; esac
      printf 'ORCA_AGY_RESPONSE %s\n' "$status"
      cat "$response_file"
      exit 0
    fi
  done
done <<ORCA_AGY_LOGS
$candidates
ORCA_AGY_LOGS
if [ "$found_live" -eq 0 ]; then
  printf 'ORCA_AGY_NOT_RUNNING'
else
  printf 'ORCA_AGY_UNVERIFIABLE'
fi
`

export type AntigravityWslProbeResult =
  | { kind: 'response'; statusCode: number; body: string }
  | { kind: 'not-running' }
  | { kind: 'unverifiable'; reason: string }

export async function probeAntigravityQuotaInWsl(
  wslDistro: string | null,
  signal?: AbortSignal
): Promise<AntigravityWslProbeResult> {
  const terminationBarrier = createWslProcessGroupTermination(wslDistro ?? undefined)
  const result = await runWslProcess({
    script: ANTIGRAVITY_WSL_PROBE_SCRIPT,
    shell: 'sh',
    loginPath: 'preferred',
    ...(wslDistro ? { distro: wslDistro } : {}),
    timeoutMs: 30_000,
    maxOutputBytes: MAX_CAPTURE_BYTES,
    signal,
    terminationBarrier
  })
  if (signal?.aborted) {
    throw signal.reason
  }
  if (result.timedOut || result.code !== 0 || result.stdout === 'ORCA_AGY_UNVERIFIABLE') {
    return { kind: 'unverifiable', reason: 'Antigravity quota could not be verified in WSL' }
  }
  if (result.stdout === 'ORCA_AGY_NOT_RUNNING') {
    return { kind: 'not-running' }
  }
  if (result.stdout === 'ORCA_AGY_RESPONSE_TOO_LARGE') {
    return { kind: 'unverifiable', reason: 'Antigravity quota response too large' }
  }
  const match = /^ORCA_AGY_RESPONSE (\d{3})\n/.exec(result.stdout)
  if (!match) {
    return { kind: 'unverifiable', reason: 'Antigravity quota response was unreadable in WSL' }
  }
  const body = result.stdout.slice(match[0].length)
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    return { kind: 'unverifiable', reason: 'Antigravity quota response too large' }
  }
  return { kind: 'response', statusCode: Number(match[1]), body }
}
