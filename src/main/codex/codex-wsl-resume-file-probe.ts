import { runCapturedCodexWslProcess } from '../codex-accounts/captured-wsl-account-process'
import type { WslAccountExecutionContext } from '../wsl/wsl-account-execution-context'

/** Guest-local checks reject aliases and files owned by another user before selecting credentials. */
export const CODEX_WSL_RESUME_FILE_PROBE = `
set -euo pipefail
session_id=$1
transcript=$2
shift 2
check_file() {
  file=$1
  [ -f "$file" ] && [ ! -L "$file" ] && [ -r "$file" ] || return 0
  [ "$(readlink -f -- "$file")" = "$file" ] || return 0
  [ "$(stat -c %u -- "$file")" = "$(id -u)" ] || return 0
  printf '%s\\0' "$file"
}
for codex_home in "$@"; do
  if [ ! -e "$codex_home" ] && [ ! -L "$codex_home" ]; then continue; fi
  [ -d "$codex_home" ] && [ ! -L "$codex_home" ] && [ -r "$codex_home" ] && [ -x "$codex_home" ] || exit 80
  [ "$(readlink -f -- "$codex_home")" = "$codex_home" ] || exit 80
  [ "$(stat -c %u -- "$codex_home")" = "$(id -u)" ] || exit 80
  if [ -n "$transcript" ]; then
    case "$transcript" in "$codex_home"/sessions/*)
      plain=\${transcript%.zst}
      check_file "$plain"
      check_file "$plain.zst"
      ;;
    esac
  else
    sessions="$codex_home/sessions"
    if [ ! -e "$sessions" ] && [ ! -L "$sessions" ]; then continue; fi
    [ -d "$sessions" ] && [ ! -L "$sessions" ] && [ -r "$sessions" ] && [ -x "$sessions" ] || exit 80
    find "$sessions" -mindepth 4 -maxdepth 4 -type f \\( -name "rollout-*-$session_id.jsonl" -o -name "rollout-*-$session_id.jsonl.zst" \\) -print0 |
      while IFS= read -r -d '' file; do check_file "$file"; done
  fi
done
printf 'ORCA_CODEX_RESUME_PROBE_COMPLETE\\0'
`

export async function probeCodexWslResumeFiles(args: {
  execution: WslAccountExecutionContext
  homes: readonly string[]
  sessionId: string
  transcriptPath: string
}): Promise<Set<string>> {
  const result = await runCapturedCodexWslProcess(
    {
      distro: args.execution.distro,
      loginPath: 'none',
      shell: 'bash',
      script: CODEX_WSL_RESUME_FILE_PROBE,
      args: [args.sessionId, args.transcriptPath, ...args.homes],
      timeoutMs: 10_000,
      maxOutputBytes: 256 * 1024
    },
    args.execution
  )
  const complete = result.stdout.endsWith('ORCA_CODEX_RESUME_PROBE_COMPLETE\0')
  if (
    result.code !== 0 ||
    result.timedOut ||
    !complete ||
    Buffer.byteLength(result.stdout) >= 256 * 1024
  ) {
    throw new Error('The captured WSL Codex session files could not be verified. Retry resume.')
  }
  return new Set(
    result.stdout.slice(0, -'ORCA_CODEX_RESUME_PROBE_COMPLETE\0'.length).split('\0').filter(Boolean)
  )
}
