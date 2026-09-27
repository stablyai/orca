/**
 * What an SSH host can actually run, as one POSIX-sh probe plus a pure parser for its output.
 *
 * Why transport-free: the caller reaches this file over SSH, but the parser must be provable
 * without a remote host, and slice 1 ships no IPC or UI on top of it.
 */

import type {
  SshReadinessCheck,
  SshReadinessCheckKey,
  SshReadinessReport,
  SshReadinessState
} from '../../shared/ssh-types'

// Wire order of the probe's lines. The report mirrors it, so a UI cannot reshuffle the list
// into a different meaning than the parser's.
const SSH_READINESS_CHECK_KEYS = [
  'node',
  'toolchain',
  'github',
  'gh-auth',
  'git-identity',
  'claude',
  'codex'
] as const satisfies readonly SshReadinessCheckKey[]

/** Matches the cut in the probe script: a detail is a summary, not a log. */
const SSH_READINESS_DETAIL_LIMIT = 120

/**
 * One ssh exec, one line per check: `key<TAB>state<TAB>detail`.
 *
 * Why every check is wrapped in its own `if`/`case` and the script ends in `exit 0`:
 * a missing tool is a finding, not an error, and the caller only ever reads stdout.
 * Why nothing prints a credential: details are quoted output of read-only commands,
 * and the two probes that could echo a token (gh, codex) are reduced to a login name
 * or a placeholder before they reach a line.
 */
export const SSH_READINESS_PROBE_SCRIPT = `# Host readiness, one line per check: key<TAB>state<TAB>detail.
PATH="$HOME/.local/bin:$PATH"
export PATH

# Remote tool output can carry tabs, newlines, and more than a line's worth of text;
# the wire format cannot, so every detail is flattened and cut here.
orca_emit() {
  printf '%s\\t%s\\t%s\\n' "$1" "$2" "$(printf '%s' "$3" | tr '\\t\\n\\r' '   ' | cut -c1-120)"
}

orca_node_version=$(node --version 2>/dev/null)
orca_node_major=$(printf '%s' "$orca_node_version" | sed -e 's/^v//' -e 's/[.].*$//')
case "$orca_node_major" in
  ''|*[!0-9]*) orca_emit node miss "$orca_node_version" ;;
  *)
    if [ "$orca_node_major" -ge 18 ]; then
      orca_emit node ok "$orca_node_version"
    else
      orca_emit node miss "$orca_node_version"
    fi
    ;;
esac

if command -v make >/dev/null 2>&1 && command -v g++ >/dev/null 2>&1; then
  orca_emit toolchain ok "make and g++ present"
elif command -v make >/dev/null 2>&1; then
  orca_emit toolchain miss "missing g++"
elif command -v g++ >/dev/null 2>&1; then
  orca_emit toolchain miss "missing make"
else
  orca_emit toolchain miss "missing make and g++"
fi

# Left unquoted on purpose: expands to the two words "timeout 10", or to nothing.
# macOS ships no timeout, and a hung git must still not hang the probe forever.
orca_timeout=""
command -v timeout >/dev/null 2>&1 && orca_timeout="timeout 10"
# Why GIT_TERMINAL_PROMPT=0: a credential prompt on a private or rate-limited host would
# stall the ssh exec indefinitely, and a probe must never ask for credentials.
if GIT_TERMINAL_PROMPT=0 $orca_timeout git ls-remote https://github.com/cli/cli HEAD >/dev/null 2>&1; then
  orca_emit github ok "git ls-remote github.com ok"
else
  orca_emit github miss "git ls-remote github.com failed"
fi

# Detail is the account login, never the token: gh keeps tokens out of this output.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  orca_emit gh-auth ok "$(gh api user -q .login 2>/dev/null)"
else
  orca_emit gh-auth miss "gh missing or not logged in"
fi

orca_git_email=$(git config --global user.email 2>/dev/null)
if [ -n "$orca_git_email" ]; then
  orca_emit git-identity ok "$orca_git_email"
else
  orca_emit git-identity miss "git user.email not set"
fi

# Why absent claude stays unknown: a failed exec and a missing binary look identical here,
# and "not logged in" is a claim we would be making up. Only parsed JSON yields ok or miss.
# Both parsers run with stderr discarded: a non-zero exit is the unknown path, not a report.
orca_claude_out=$($orca_timeout claude auth status --json 2>/dev/null)
orca_claude_parsed=
if command -v node >/dev/null 2>&1; then
  orca_claude_parsed=$(printf '%s' "$orca_claude_out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j&&j.loggedIn===true?"ok":"miss")+" "+(j&&typeof j.authMethod==="string"?j.authMethod:""))}catch(e){process.stdout.write("unknown ")}})' 2>/dev/null)
elif command -v python3 >/dev/null 2>&1; then
  orca_claude_parsed=$(printf '%s' "$orca_claude_out" | python3 -c 'import json,sys;d=json.loads(sys.stdin.read());sys.stdout.write(("ok" if d.get("loggedIn") is True else "miss")+" "+(d.get("authMethod") if isinstance(d.get("authMethod"),str) else ""))' 2>/dev/null)
fi
orca_claude_state=\${orca_claude_parsed%% *}
orca_claude_method=\${orca_claude_parsed#* }
case "$orca_claude_state" in
  ok|miss) orca_emit claude "$orca_claude_state" "$orca_claude_method" ;;
  *) orca_emit claude unknown "" ;;
esac

# codex's first line names the account, so it may be echoed -- unless it mentions a
# credential word, in which case the verdict alone is published.
orca_codex_out=$($orca_timeout codex login status 2>&1)
orca_codex_status=$?
if [ "$orca_codex_status" -eq 0 ]; then
  orca_codex_first=$(printf '%s\\n' "$orca_codex_out" | head -n 1)
  orca_codex_lower=$(printf '%s' "$orca_codex_first" | tr 'A-Z' 'a-z')
  case "$orca_codex_lower" in
    *token*|*key*|*secret*) orca_emit codex ok "logged-in" ;;
    *) orca_emit codex ok "$orca_codex_first" ;;
  esac
else
  orca_emit codex miss "codex not installed or not logged in"
fi


# A check that failed is data; the exit code must never turn the report into an error.
exit 0
`

function isReadinessState(value: string): value is SshReadinessState {
  return value === 'ok' || value === 'miss' || value === 'unknown'
}

function isReadinessKey(value: string): value is SshReadinessCheckKey {
  return SSH_READINESS_CHECK_KEYS.some((key) => key === value)
}

/** Mirrors the probe's own flattening: a future or host-swapped probe may not cut to fit. */
function normalizeDetail(detail: string): string {
  return detail.replaceAll('\r', '').slice(0, SSH_READINESS_DETAIL_LIMIT)
}

/**
 * Parse the probe's stdout. Unknown keys and malformed lines are dropped rather than
 * rejected, because a newer probe may emit checks this client has no name for yet, and
 * a check that never reported must read as `unknown` -- not as a pass.
 */
export function parseSshReadiness(stdout: string, now = Date.now()): SshReadinessReport {
  const reported = new Map<SshReadinessCheckKey, SshReadinessCheck>()
  for (const line of stdout.split('\n')) {
    const fields = line.split('\t')
    if (fields.length < 3) {
      continue
    }
    const [key, state] = fields
    if (!isReadinessKey(key) || !isReadinessState(state)) {
      continue
    }
    reported.set(key, { key, state, detail: normalizeDetail(fields.slice(2).join(' ')) })
  }
  return {
    checks: SSH_READINESS_CHECK_KEYS.map(
      (key) => reported.get(key) ?? { key, state: 'unknown', detail: '' }
    ),
    probedAt: now
  }
}
