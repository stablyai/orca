// The repo's orca.yaml `scripts.archive` for an Orca Cloud workspace, run on the still-running VM
// before it is archived or deleted, so what the workspace started outside itself (a preview
// database branch, say) stops billing. The desktop calls it first and decides what a failure means:
// it shows the output and offers "Archive anyway". Asleep, the caller chooses whether to wake it.
//
// The script comes from the primary checkout's orca.yaml, as on the desktop. It runs in each
// workspace checkout: the linked worktrees when there are any, else the primary checkout (where an
// API-created workspace ran its setup). Bash with `set -e`, as the user, with orcad's process env
// (managed ORCA_* names and the session's secrets) plus the setup runner's ORCA_* path names.
// One budget for all of them; output is kept per checkout and appended to
// ~/.orca-sandbox/archive-hook/archive.log in the VM.
import type {
  HostedArchiveHookMemo,
  HostedArchiveHookResult,
  HostedArchiveHookRun
} from '../../../../src/shared/hosted-sandbox/hosted-archive-hook-wire'
import { parseOrcaYaml } from '../../../../src/shared/workspace-setup/orca-yaml'
import { PROJECT_ROOT } from './api/vm-agent'
import { runnerScript } from './project-setup'
import { ProviderError, type SandboxProviderApi } from './sandbox-provider'
import type { SandboxRow } from './store'

export const ARCHIVE_HOOK_TIMEOUT_MS = 120_000
/** Per checkout; the provider caps a command's whole output at 256 KiB. */
const OUTPUT_TAIL_BYTES = 6 * 1024
const MAX_CHECKOUTS = 20
/** orcad holds the session's env and secrets; a VM that just woke may still be starting it. */
const ORCAD_WAIT_SECONDS = 30
/** A Sleep never waits long on this read. */
const LEARN_TIMEOUT_MS = 5_000

/**
 * `bash -c RUNNER orca-archive-hook <runner script> <budget seconds>`. The script is data written to
 * a file. One `ORCA_ARCHIVE_HOOK <b64 path> <exit> <b64 output tail>` line per checkout.
 */
const RUNNER = String.raw`set -u
umask 077
P=${PROJECT_ROOT}
D="$HOME/.orca-sandbox/archive-hook"
mkdir -p "$D"
# One run at a time per workspace: a second request answers busy instead of running it alongside.
exec 9>"$D/lock"
flock -n 9 || { echo ORCA_ARCHIVE_HOOK_BUSY; exit 0; }
printf '%s' "$1" >"$D/archive.sh"
opid=""
for _ in $(seq 1 ${ORCAD_WAIT_SECONDS}); do
  opid="$(cat "$HOME/.orca-sandbox/orcad.pid" 2>/dev/null || true)"
  [ -n "$opid" ] && [ -r "/proc/$opid/environ" ] && break
  opid=""; sleep 1
done
if [ -z "$opid" ]; then echo ORCA_ARCHIVE_HOOK_NO_ORCAD; exit 0; fi
end=$(( $(date +%s) + $2 ))
# git lists the primary checkout first (under its real path, which $P may only link to).
git -C "$P" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10)}' >"$D/targets" || true
if [ "$(wc -l <"$D/targets")" -gt 1 ]; then
  tail -n +2 "$D/targets" | head -n ${MAX_CHECKOUTS} >"$D/targets.run"
else
  echo "$P" >"$D/targets.run"
fi
while IFS= read -r dir; do
  [ -d "$dir" ] || continue
  left=$(( end - $(date +%s) ))
  code=124
  {
    echo "orca: archive hook in $dir at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if [ "$left" -gt 0 ]; then
      (
        while IFS= read -r -d '' kv; do
          case "$kv" in [A-Za-z_]*=*) export "$kv" 2>/dev/null || true ;; esac
        done <"/proc/$opid/environ"
        export GIT_TERMINAL_PROMPT=0 ORCA_ROOT_PATH="$P" ORCA_WORKTREE_PATH="$dir" ORCA_WORKSPACE_NAME="$(basename "$dir")"
        export CONDUCTOR_ROOT_PATH="$P" CONDUCTOR_WORKSPACE_PATH="$dir" CONDUCTOR_WORKSPACE_NAME="$(basename "$dir")" GHOSTX_ROOT_PATH="$P"
        cd "$dir" && exec timeout --kill-after=5 "$left" bash "$D/archive.sh" </dev/null
      ) >"$D/out" 2>&1
      code=$?
    else
      echo 'orca: no time left for this checkout' >"$D/out"
    fi
    cat "$D/out"
    echo "orca: archive hook exited $code"
  } >>"$D/archive.log" 2>&1
  printf 'ORCA_ARCHIVE_HOOK %s %s %s\n' "$(printf '%s' "$dir" | base64 -w0)" "$code" "$(tail -c ${OUTPUT_TAIL_BYTES} "$D/out" | base64 -w0)"
done <"$D/targets.run"`

function decodeBase64Utf8(value: string): string {
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** `timeout` answers 124 on the deadline and 137 when it had to kill; neither is the script's own exit. */
function parseRun(line: string): HostedArchiveHookRun | null {
  const match = /^ORCA_ARCHIVE_HOOK (\S*) (\d+) (\S*)$/.exec(line)
  if (!match) {
    return null
  }
  const code = Number(match[2])
  const timedOut = code === 124 || code === 137
  return {
    path: decodeBase64Utf8(match[1]!),
    exitCode: timedOut ? null : code,
    timedOut,
    output: decodeBase64Utf8(match[3]!)
  }
}

/** The repo's archive script, or null when its orca.yaml has none. */
export async function readArchiveScript(provider: SandboxProviderApi, sessionId: string): Promise<string | null> {
  const yaml = await provider.readFile(sessionId, `${PROJECT_ROOT}/orca.yaml`)
  return (yaml ? parseOrcaYaml(yaml)?.scripts.archive?.trim() : undefined) || null
}

export async function runArchiveHook(
  provider: SandboxProviderApi,
  sessionId: string,
  options: { timeoutMs?: number } = {}
): Promise<HostedArchiveHookResult> {
  const timeoutMs = options.timeoutMs ?? ARCHIVE_HOOK_TIMEOUT_MS
  try {
    const script = await readArchiveScript(provider, sessionId)
    if (!script) {
      return { state: 'not_configured' }
    }
    const result = await provider.runCommand(sessionId, {
      command: 'bash',
      args: ['-c', RUNNER, 'orca-archive-hook', runnerScript(script), String(Math.ceil(timeoutMs / 1000))],
      timeoutMs: timeoutMs + (ORCAD_WAIT_SECONDS + 20) * 1000
    })
    const lines = result.stdout.split('\n')
    if (lines.includes('ORCA_ARCHIVE_HOOK_NO_ORCAD')) {
      return { state: 'failed', runs: [], reason: 'no_server' }
    }
    if (lines.includes('ORCA_ARCHIVE_HOOK_BUSY')) {
      return { state: 'failed', runs: [], reason: 'busy' }
    }
    const runs = lines.map(parseRun).filter((run): run is HostedArchiveHookRun => run !== null)
    if (runs.length === 0) {
      return { state: 'failed', runs: [], reason: 'no_answer' }
    }
    return { state: runs.every((run) => run.exitCode === 0) ? 'succeeded' : 'failed', runs }
  } catch (error) {
    if (error instanceof ProviderError) {
      return { state: 'failed', runs: [], reason: 'unreachable' }
    }
    throw error
  }
}

/** What the control plane last learned about the hook; null when it never looked. */
export function archiveHookMemo(row: SandboxRow): HostedArchiveHookMemo | null {
  const value = (row as { archive_hook?: string | null }).archive_hook
  return value === 'none' || value === 'pending' || value === 'done' ? value : null
}

/** A hook run's own outcome; a failure after an earlier success makes it pending again. */
export async function recordArchiveHookMemo(db: D1Database, sandboxId: string, memo: HostedArchiveHookMemo): Promise<void> {
  await db.prepare('UPDATE sandboxes SET archive_hook = ? WHERE id = ?').bind(memo, sandboxId).run()
}

/** What a Sleep learned: `pending` keeps `done`, since the desktop's Sleep runs after a successful hook. */
async function recordLearnedArchiveHook(db: D1Database, sandboxId: string, hasHook: boolean): Promise<void> {
  await db
    .prepare(`UPDATE sandboxes SET archive_hook = CASE WHEN ?1 = 'pending' AND archive_hook = 'done' THEN 'done' ELSE ?1 END WHERE id = ?2`)
    .bind(hasHook ? 'pending' : 'none', sandboxId)
    .run()
}

/** A woken workspace may start what the hook tore down again: the next archive runs it again. */
export async function resetArchiveHookMemo(db: D1Database, sandboxId: string): Promise<void> {
  await db.prepare(`UPDATE sandboxes SET archive_hook = 'pending' WHERE id = ? AND archive_hook = 'done'`).bind(sandboxId).run()
}

/** Learn whether the repo has a hook while the VM still runs (before a sleep), so an asleep archive can ask. */
export async function learnArchiveHook(provider: SandboxProviderApi, db: D1Database, row: SandboxRow): Promise<void> {
  if (!row.session_id) {
    return
  }
  try {
    const script = await Promise.race([
      readArchiveScript(provider, row.session_id),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), LEARN_TIMEOUT_MS))
    ])
    await recordLearnedArchiveHook(db, row.id, script !== null)
  } catch (error) {
    console.log(JSON.stringify({ event: 'archive_hook_learn_failed', sandboxId: row.id, error: String(error).slice(0, 120) }))
  }
}

export const ARCHIVE_HOOK_SCRIPTS_FOR_TESTS = { RUNNER }
