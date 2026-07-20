#!/usr/bin/env bash
# Purge accidental `tsc` emits that land next to .ts/.tsx under src/.
# Vite prefers sibling .js over .tsx, so stale emits ship old UI
# (React #185 incident 2026-07-20: QuickAdd never updated in packaged builds).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
count=0
while IFS= read -r -d '' j; do
  base="${j%.js}"
  if [[ -f "${base}.tsx" || -f "${base}.ts" ]]; then
    rm -f "$j" "${base}.d.ts" "${base}.js.map"
    count=$((count + 1))
  fi
done < <(find src -name '*.js' -type f -print0 2>/dev/null)
echo "purged $count sibling .js emit(s) under src/"
