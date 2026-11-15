// At-most-once commands in a sandbox. The provider's command API (POST .../cmd) takes no idempotency
// key: if Vercel starts a command and its answer is lost (dropped connection, a gateway 5xx, a Worker
// that died mid-request), sending the same POST again starts the command a second time
// (github.com/vercel/sandbox/issues/363). Orca's REST client never retries a command on its own;
// a caller that must retry one with side effects (typing a message into an agent, launching an agent)
// goes through `runCommandOnce` with a stable id instead.
//
// The command runs inside a small guard that keeps a per-id ledger on the VM's disk:
//   - the first run claims `$HOME/.orca-once/<id>` with `mkdir` (atomic), runs, and records its
//     exit code and output there;
//   - a repeat of the same id waits for the first one and replays its recorded result (never runs);
//   - a repeat that finds the first run dead without a result reports `lost` (the outcome is unknown:
//     the caller must not guess);
//   - a failed run (non-zero exit) is forgotten, so a retry runs it again: a command that failed is
//     assumed to have had no effect (Orca's CLI exits non-zero on every error envelope).
// Entries older than a day are dropped. Output is kept on the VM disk (0700): never use this for a
// command that prints a secret.
import { ProviderError, type CommandResult, type RunCommandParams, type SandboxProviderApi } from './sandbox-provider'

const ID = /^[A-Za-z0-9_.-]{1,96}$/
const MARK = '__orca_once__ '

/** `bash -c GUARD orca-once <id> <command> [args...]`; the first stdout line is the guard's verdict. */
export const ONCE_GUARD = String.raw`set -u
id="$1"; shift
case "$id" in '' | *[!A-Za-z0-9_.-]*) echo "orca-once: invalid id" >&2; exit 2 ;; esac
B="$HOME/.orca-once"
D="$B/$id"
umask 077
mkdir -p "$B"
find "$B" -mindepth 1 -maxdepth 1 -type d -mmin +1440 -exec rm -rf {} + 2>/dev/null || true
wait_s="${'$'}{ORCA_ONCE_WAIT:-30}"
waited=0
while :; do
  if mkdir "$D" 2>/dev/null; then
    echo "$$" >"$D/pid"
    "$@" >"$D/out" 2>"$D/err" </dev/null
    code=$?
    if [ "$code" = 0 ]; then
      echo 0 >"$D/exit.tmp" && mv "$D/exit.tmp" "$D/exit"
      printf '%s{"state":"ran","exit":0}\n' "${MARK}"
      cat "$D/out"; cat "$D/err" >&2
    else
      T="$(mktemp -d)"
      mv "$D/out" "$D/err" "$T/" 2>/dev/null
      rm -rf "$D"
      printf '%s{"state":"ran","exit":%s}\n' "${MARK}" "$code"
      cat "$T/out" 2>/dev/null; cat "$T/err" >&2 2>/dev/null
      rm -rf "$T"
    fi
    exit "$code"
  fi
  if [ -s "$D/exit" ]; then
    code="$(cat "$D/exit")"
    printf '%s{"state":"replayed","exit":%s}\n' "${MARK}" "$code"
    cat "$D/out" 2>/dev/null; cat "$D/err" >&2 2>/dev/null
    exit "$code"
  fi
  pid="$(cat "$D/pid" 2>/dev/null || true)"
  if [ -d "$D" ] && [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null && [ ! -s "$D/exit" ]; then
    printf '%s{"state":"lost"}\n' "${MARK}"
    exit 0
  fi
  if [ "$waited" -ge "$wait_s" ]; then
    printf '%s{"state":"running"}\n' "${MARK}"
    exit 0
  fi
  sleep 1
  waited=$((waited + 1))
done`

export type OnceState = 'ran' | 'replayed'
export type OnceResult = CommandResult & { state: OnceState; attempts: number }

/** The guard could not say what happened: `lost` (first run died) or `running` (still going). */
export class CommandOutcomeError extends Error {
  constructor(readonly code: 'command_outcome_unknown' | 'command_in_progress') {
    super(code)
    this.name = 'CommandOutcomeError'
  }
}

/** A provider failure after which the command may or may not have started: safe to retry with the guard. */
export function isUncertainFailure(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return error.status >= 500 || error.status === 429 || error.status === 408 || error.code === 'command_unfinished' || error.code === 'invalid_response'
  }
  // fetch rejects with TypeError (network) or an AbortError/timeout; none of them say the command didn't run.
  return error instanceof Error && !(error instanceof CommandOutcomeError)
}

export function onceInvocation(id: string, params: RunCommandParams): RunCommandParams {
  if (!ID.test(id)) {
    throw new Error('invalid_once_id')
  }
  return {
    command: 'bash',
    args: ['-c', ONCE_GUARD, 'orca-once', id, params.command, ...(params.args ?? [])],
    cwd: params.cwd,
    sudo: params.sudo,
    // A repeat waits for a first run still in flight, up to just under its own timeout.
    env: { ...params.env, ORCA_ONCE_WAIT: String(Math.max(1, Math.floor(params.timeoutMs / 1000) - 5)) },
    timeoutMs: params.timeoutMs
  }
}

/** Splits the guard's verdict line off the command's own stdout. */
export function parseOnceOutput(result: CommandResult): { state: OnceState | 'lost' | 'running'; result: CommandResult } {
  const newline = result.stdout.indexOf('\n')
  const first = newline === -1 ? result.stdout : result.stdout.slice(0, newline)
  if (!first.startsWith(MARK)) {
    throw new ProviderError(200, 'once_guard_missing')
  }
  let verdict: { state?: unknown }
  try {
    verdict = JSON.parse(first.slice(MARK.length)) as { state?: unknown }
  } catch {
    throw new ProviderError(200, 'once_guard_missing')
  }
  const state = verdict.state
  if (state !== 'ran' && state !== 'replayed' && state !== 'lost' && state !== 'running') {
    throw new ProviderError(200, 'once_guard_missing')
  }
  return { state, result: { ...result, stdout: newline === -1 ? '' : result.stdout.slice(newline + 1) } }
}

/**
 * Runs `params` at most once per `id` on this VM, retrying the provider call (same id) when its
 * failure leaves the outcome uncertain. A retry never runs the command again: it replays the first
 * run's result. Throws CommandOutcomeError when no attempt can tell what happened.
 */
export async function runCommandOnce(
  provider: Pick<SandboxProviderApi, 'runCommand'>,
  sessionId: string,
  id: string,
  params: RunCommandParams,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<OnceResult> {
  const invocation = onceInvocation(id, params)
  const attempts = Math.max(1, options.attempts ?? 3)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let raw: CommandResult
    try {
      raw = await provider.runCommand(sessionId, invocation)
    } catch (error) {
      if (!isUncertainFailure(error) || attempt === attempts) {
        throw error
      }
      lastError = error
      console.log(JSON.stringify({ event: 'command_once_retry', id, attempt, error: error instanceof ProviderError ? `${error.status}:${error.code ?? ''}` : 'network' }))
      await sleep(500 * attempt)
      continue
    }
    const parsed = parseOnceOutput(raw)
    if (parsed.state === 'lost') {
      throw new CommandOutcomeError('command_outcome_unknown')
    }
    if (parsed.state === 'running') {
      throw new CommandOutcomeError('command_in_progress')
    }
    if (parsed.state === 'replayed' || attempt > 1) {
      console.log(JSON.stringify({ event: 'command_once_result', id, state: parsed.state, attempt }))
    }
    return { ...parsed.result, state: parsed.state, attempts: attempt }
  }
  throw lastError
}
