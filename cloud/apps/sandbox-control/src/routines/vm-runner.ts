// The in-VM side of a routine run. A Worker cannot block for the minutes an agent takes, so the
// control plane starts a detached runner (nohup + setsid) and polls a result file on every tick.
//
// Both scripts are fixed text. Everything the user wrote (prompt, routine name) travels as argv
// entries and is only ever read as "$N" / from files, never interpolated into a shell line.
// The runner takes orcad's process env (the session's injected secrets and the GitHub placeholder,
// memory only) so the headless agent sees exactly what an interactive agent in that VM would.
import { z } from 'zod'
import type { SandboxProviderApi } from '../sandbox-provider'
import type { AgentId } from '../api/vm-agent'
import type { PostResults } from './store'

/**
 * `bash -c LAUNCHER routine <mode> <runId> ...`:
 *   start  <runId> <agent> <post> <limitSeconds> <branch> <title> <prompt> <worker script>
 *   status <runId>
 *   kill   <runId>
 */
const LAUNCHER = String.raw`set -u
umask 077
mode="$1" run="$2"
case "$run" in '' | *[!A-Za-z0-9_-]*) echo '{"state":"invalid"}'; exit 0 ;; esac
D="$HOME/.orca-routines/$run"
log_json() { { tail -c 1500 "$D/agent.err" 2>/dev/null; tail -c 1500 "$D/worker.log" 2>/dev/null; } | jq -Rs . 2>/dev/null || echo '""'; }
case "$mode" in
start)
  mkdir -p "$D"
  if [ -s "$D/pid" ]; then echo '{"state":"started","again":true}'; exit 0; fi
  opid="$(cat "$HOME/.orca-sandbox/orcad.pid" 2>/dev/null || true)"
  if [ -z "$opid" ] || [ ! -r "/proc/$opid/environ" ]; then echo '{"state":"no_orcad"}'; exit 0; fi
  printf '%s\n%s\n%s\n%s\n' "$3" "$4" "$5" "$6" >"$D/args"
  printf '%s' "$7" >"$D/title.txt"
  printf '%s' "$8" >"$D/prompt.txt"
  printf '%s' "$9" >"$D/worker.sh"
  setsid nohup bash "$D/worker.sh" "$D" "$opid" >"$D/worker.log" 2>&1 </dev/null &
  echo $! >"$D/pid"
  echo '{"state":"started"}'
  ;;
status)
  if [ -s "$D/result.json" ]; then
    printf '{"state":"done","result":%s,"log":%s}\n' "$(jq -c . "$D/result.json")" "$(log_json)"
  elif [ -s "$D/pid" ] && kill -0 "$(cat "$D/pid")" 2>/dev/null; then
    printf '{"state":"running","log":%s}\n' "$(log_json)"
  elif [ -s "$D/pid" ]; then
    printf '{"state":"died","log":%s}\n' "$(log_json)"
  else
    echo '{"state":"missing"}'
  fi
  ;;
kill)
  if [ -s "$D/pid" ]; then kill -TERM -- "-$(cat "$D/pid")" 2>/dev/null || kill -TERM "$(cat "$D/pid")" 2>/dev/null || true; fi
  echo '{"state":"killed"}'
  ;;
*) echo '{"state":"invalid"}' ;;
esac`

/** The detached runner: agent, then (pr mode) commit + push + PR, then result.json. */
const WORKER = String.raw`set -u
D="$1" opid="$2"
P=/vercel/sandbox/project
while IFS= read -r -d '' kv; do
  case "$kv" in [A-Za-z_]*=*) export "$kv" 2>/dev/null || true ;; esac
done <"/proc/$opid/environ"
export IS_SANDBOX=1 CI=1 NO_COLOR=1 GIT_TERMINAL_PROMPT=0
{ read -r agent; read -r post; read -r limit; read -r branch; } <"$D/args"
code=0 summary="" pr="" pushed=false changed=false base="" note=""
finish() {
  jq -cn --argjson code "$code" --arg summary "$summary" --arg pr "$pr" --arg branch "$branch" --arg base "$base" \
    --argjson pushed "$pushed" --argjson changed "$changed" --arg note "$note" \
    '{exitCode: $code, timedOut: ($code == 124 or $code == 137), summary: $summary, prUrl: $pr, branch: $branch,
      base: $base, pushed: $pushed, changed: $changed, note: $note}' >"$D/result.json.tmp" && mv "$D/result.json.tmp" "$D/result.json"
  exit 0
}
cd "$P" 2>/dev/null || { code=2; note=no_project; finish; }
base="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
start_sha="$(git rev-parse HEAD 2>/dev/null || true)"
echo "routine: agent=$agent post=$post limit=$limit base=$base"
# The workspace's orca.yaml setup (src/project-setup.ts) installs what the agent needs: let it finish.
S="$HOME/.orca-sandbox/project-setup"
if [ -e "$S/started" ] && [ ! -e "$S/exit" ]; then
  echo "routine: waiting for orca.yaml setup"
  while [ ! -e "$S/exit" ] && kill -0 "$(cat "$S/pid" 2>/dev/null || echo 0)" 2>/dev/null; do sleep 2; done
fi
[ -e "$S/exit" ] && echo "routine: orca.yaml setup $(cat "$S/exit")"
case "$agent" in
claude)
  # The prompt goes in on stdin: as an argv entry, text starting with "-" would parse as a flag.
  timeout --kill-after=20 "$limit" claude -p --output-format json --dangerously-skip-permissions \
    >"$D/agent.out" 2>"$D/agent.err" <"$D/prompt.txt" || code=$?
  summary="$(jq -r '.result // empty' "$D/agent.out" 2>/dev/null | head -c 6000)"
  if [ "$code" = 0 ] && [ "$(jq -r '.is_error // false' "$D/agent.out" 2>/dev/null)" = true ]; then code=1; fi
  ;;
codex)
  timeout --kill-after=20 "$limit" codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
    --output-last-message "$D/last.txt" - >"$D/agent.out" 2>"$D/agent.err" <"$D/prompt.txt" || code=$?
  summary="$(head -c 6000 "$D/last.txt" 2>/dev/null || true)"
  ;;
*) code=2; note=unknown_agent; finish ;;
esac
[ -n "$summary" ] || summary="$(tail -c 2000 "$D/agent.out" 2>/dev/null || true)"
echo "routine: agent exit $code"
if [ "$code" = 0 ] && [ "$post" = pr ] && [ -n "$start_sha" ]; then
  git add -A >/dev/null 2>&1 || true
  if ! git diff --cached --quiet 2>/dev/null; then
    git -c user.name="Orca Routine" -c user.email="routines@onorca.dev" commit -q -m "$(cat "$D/title.txt")" -m "$summary" || note=commit_failed
  fi
  if [ "$(git rev-parse HEAD)" != "$start_sha" ]; then
    changed=true
    git checkout -q -B "$branch" && git push -q origin "HEAD:refs/heads/$branch" && pushed=true || note=push_failed
    if [ "$pushed" = true ]; then
      printf '%s\n\n---\nOpened by an Orca Cloud routine.\n' "$summary" >"$D/pr-body.md"
      pr="$(gh pr create --base "$base" --head "$branch" --title "$(cat "$D/title.txt")" --body-file "$D/pr-body.md" 2>>"$D/agent.err" | tail -n 1)" || note=gh_pr_failed
      case "$pr" in https://*) ;; *) pr="" ;; esac
    fi
  else
    note=no_changes
  fi
fi
finish`

const Status = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('done'),
    result: z
      .object({
        exitCode: z.number().int(),
        timedOut: z.boolean(),
        summary: z.string(),
        prUrl: z.string(),
        branch: z.string(),
        base: z.string(),
        pushed: z.boolean(),
        changed: z.boolean(),
        note: z.string()
      })
      .loose(),
    log: z.string().optional()
  }),
  z.object({ state: z.literal('running'), log: z.string().optional() }),
  z.object({ state: z.literal('died'), log: z.string().optional() }),
  z.object({ state: z.enum(['missing', 'invalid', 'no_orcad', 'started', 'killed']), again: z.boolean().optional() })
])
export type RunnerStatus = z.infer<typeof Status>
export type RunnerResult = Extract<RunnerStatus, { state: 'done' }>['result']

export class RunnerError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RunnerError'
  }
}

async function launcher(provider: SandboxProviderApi, sessionId: string, args: string[], timeoutMs = 30_000): Promise<RunnerStatus> {
  const result = await provider.runCommand(sessionId, { command: '/bin/bash', args: ['-c', LAUNCHER, 'routine', ...args], timeoutMs })
  // One JSON document; take the outermost object so a stray line (or a pretty-printed file) cannot break parsing.
  const start = result.stdout.indexOf('{')
  const end = result.stdout.lastIndexOf('}')
  try {
    return Status.parse(JSON.parse(result.stdout.slice(start, end + 1)))
  } catch {
    throw new RunnerError(`runner_output_invalid:${result.exitCode}`)
  }
}

export async function startRunner(
  provider: SandboxProviderApi,
  sessionId: string,
  input: { runId: string; agent: AgentId; post: PostResults; limitSeconds: number; branch: string; title: string; prompt: string }
): Promise<void> {
  const status = await launcher(provider, sessionId, [
    'start',
    input.runId,
    input.agent,
    input.post,
    String(input.limitSeconds),
    input.branch,
    input.title,
    input.prompt,
    WORKER
  ])
  if (status.state !== 'started') {
    throw new RunnerError(`runner_${status.state}`)
  }
}

export function runnerStatus(provider: SandboxProviderApi, sessionId: string, runId: string): Promise<RunnerStatus> {
  return launcher(provider, sessionId, ['status', runId])
}

export async function killRunner(provider: SandboxProviderApi, sessionId: string, runId: string): Promise<void> {
  await launcher(provider, sessionId, ['kill', runId]).catch(() => undefined)
}

/** Strips anything credential-shaped from log text before it is stored or shown. */
export function redactLog(text: string, max = 2000): string {
  return text
    .replace(/orca-ph-[A-Za-z0-9_-]+/g, '[placeholder]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|vck_[A-Za-z0-9_-]{16,}|orca_sk_[A-Za-z0-9]{16,}|whk_[A-Za-z0-9_]{20,})/g, '[redacted]')
    .replace(/(authorization|x-api-key|token|secret|password)(["']?\s*[:=]\s*["']?)(bearer\s+|basic\s+)?[^\s"',]{8,}/gi, '$1$2[redacted]')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]|[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .slice(-max)
}

export const RUNNER_SCRIPTS_FOR_TESTS = { LAUNCHER, WORKER }
