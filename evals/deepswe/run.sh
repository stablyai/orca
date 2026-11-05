#!/usr/bin/env bash
# Run DeepSWE tasks with Claude Code and/or Codex on subscription auth (no API keys).
# Usage: evals/deepswe/run.sh <claude|codex|claude-stripped|codex-stripped> <job-name> [all | task-name ...]
set -euo pipefail

EVAL_HOME="${DEEPSWE_EVAL_HOME:-$HOME/deepswe-eval}"
HERE="$(cd "$(dirname "$0")" && pwd)"
agent="$1"; job="$2"; shift 2
tasks=("$@")
[ ${#tasks[@]} -eq 0 ] && tasks=(tomlkit-toml-table-converters httpx-deterministic-cookie-store fd-deterministic-multi-key-sorting abs-module-cache-flags)

includes=()
[ "${tasks[0]}" = all ] || for t in "${tasks[@]}"; do includes+=(-i "$t"); done
# SEED gives a deterministic task order, so two arms run the same tasks first.
[ -n "${SEED:-}" ] && includes+=(--sample-seed "$SEED")

common=(-y -p "$EVAL_HOME/deep-swe/tasks" ${includes[@]+"${includes[@]}"} --ak "reasoning_effort=${EFFORT:-high}"
  -e docker --cpus ignore --memory ignore -n "${CONCURRENCY:-1}" -o "$EVAL_HOME/jobs" --job-name "$job")

claude_run() { # ANTHROPIC_BASE_URL would replace api.anthropic.com in the sandbox allowlist.
  env -u ANTHROPIC_BASE_URL PYTHONPATH="$HERE" pier run "${common[@]}" "$@" \
    -m "${CLAUDE_MODEL:-anthropic/claude-opus-5-5}" --env-file "$EVAL_HOME/claude.env"
}
codex_run() {
  CODEX_FORCE_AUTH_JSON=1 PYTHONPATH="$HERE" pier run "${common[@]}" "$@" -m "${CODEX_MODEL:-openai/gpt-6.1-terra}"
}

case "$agent" in
  claude) claude_run --agent claude-code ;;
  codex) codex_run --agent-import-path subscription_codex:SubscriptionCodex ;;
  claude-stripped) claude_run --agent-import-path stripped_agents:StrippedClaudeCode ;;
  codex-stripped) codex_run --agent-import-path stripped_agents:StrippedCodex ;;
  *) echo "agent must be claude, codex, claude-stripped or codex-stripped" >&2; exit 2 ;;
esac
