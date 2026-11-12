#!/bin/bash
# Runs every line of a spec file through the D2/D3 polling harness.
# Usage: run-specs.sh <spec-file> [parallel=4] [name-filter-regex]
# Spec line: "<name> ENV=VALUE ENV=VALUE ...". Blank lines and lines starting with # are skipped.
# Writes results/<name>.json and logs/<name>.log next to this script.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
SPEC="${1:?spec file}"
PAR="${2:-4}"
FILTER="${3:-.}"
PER_RUN_TIMEOUT_S="${PER_RUN_TIMEOUT_S:-3000}"
mkdir -p "$HERE/results" "$HERE/logs"
cd "$ROOT" || exit 2
run_one() {
  local name="$1"; shift
  local start=$SECONDS
  env "$@" EXP_OUT="$HERE/results/$name.json" VITE_CONFIG_NATIVE_IGNORE_WARNING=true \
    perl -e 'alarm shift; exec @ARGV' "$PER_RUN_TIMEOUT_S" \
    npx vitest run --config config/vitest.config.ts \
    src/main/github/__experiments__/polling-d2.experiment.test.ts > "$HERE/logs/$name.log" 2>&1
  echo "$name rc=$? wall=$((SECONDS - start))s"
}
active=0
while read -r name rest; do
  [ -z "${name:-}" ] && continue
  case "$name" in \#*) continue ;; esac
  echo "$name" | grep -Eq "$FILTER" || continue
  # shellcheck disable=SC2086
  run_one "$name" $rest &
  active=$((active + 1))
  # Batches of PAR (portable to the bash 3.2 that ships with macOS: no `wait -n`).
  if [ "$active" -ge "$PAR" ]; then wait; active=0; fi
done < "$SPEC"
wait
echo ALL DONE
