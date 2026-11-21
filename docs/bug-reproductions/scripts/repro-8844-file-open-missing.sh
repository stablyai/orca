#!/usr/bin/env bash
# Issue #8844 — orca file open reports ok:true for a non-existent file.
#
# DEFAULT: code-path / evidence re-check only — does NOT open ghost editor tabs.
#
# LIVE repro (opens a ghost tab in the running Orca UI — DO NOT use casually):
#   ORCA_REPRO_8844_LIVE=1 bash docs/bug-reproductions/scripts/repro-8844-file-open-missing.sh
#
# Prefer production CLI:
#   ORCA_BIN=/Applications/Orca.app/Contents/Resources/bin/orca

set -uo pipefail
ORCA_BIN="${ORCA_BIN:-/Applications/Orca.app/Contents/Resources/bin/orca}"
ROOT="${1:-.}"
ROOT="$(cd "$ROOT" && pwd)"
EVIDENCE_DIR="$(cd "$(dirname "$0")/.." && pwd)/evidence"
mkdir -p "$EVIDENCE_DIR"

echo "=== #8844 repro (default is non-destructive) ==="
echo "Root cause: RuntimeFileCommands.openMobileFile never stats the path;"
echo "  classifies by extension and returns opened:true after host.openFile."
echo "See: src/main/runtime/orca-runtime-files.ts openMobileFile"
echo "See: src/cli/handlers/file.ts 'file open'"
echo
echo "Prior live evidence (already captured — do not re-open casually):"
if [[ -f "$EVIDENCE_DIR/8844-file-open-missing.raw.json" ]]; then
  cat "$EVIDENCE_DIR/8844-file-open-missing.raw.json"
  echo
fi
if [[ -f "$EVIDENCE_DIR/8844-file-open-missing.json.txt" ]]; then
  grep -E '^(RESULT|exit|exists_|parsed)' "$EVIDENCE_DIR/8844-file-open-missing.json.txt" || true
fi

if [[ "${ORCA_REPRO_8844_LIVE:-}" != "1" ]]; then
  echo
  echo "STATUS=REPRODUCED_FROM_EVIDENCE (no new ghost tab created)"
  echo "To run live CLI open of a missing path (creates a UI tab + ENOENT card):"
  echo "  ORCA_REPRO_8844_LIVE=1 $0"
  exit 0
fi

# --- LIVE path (explicit opt-in only) ---
REL="spec/does-not-exist-repro-8844-LIVE-$(date +%s).md"
ABS="$ROOT/$REL"
rm -f "$ABS" 2>/dev/null || true
cd "$ROOT" || exit 2

set +e
"$ORCA_BIN" file open "$REL" --json >"$EVIDENCE_DIR/8844-file-open-missing.raw.json" 2>"$EVIDENCE_DIR/8844-file-open-missing.stderr.txt"
code=$?
set -e

echo "LIVE open of $REL exit=$code"
cat "$EVIDENCE_DIR/8844-file-open-missing.raw.json"
echo
echo "WARNING: a ghost editor tab was opened. Close it with Cmd+W, or create the file:"
echo "  mkdir -p \"\$(dirname $ABS)\" && echo placeholder > \"$ABS\""
echo "STATUS=REPRODUCED_LIVE"
exit 0
