#!/usr/bin/env bash
# Issue #8454 — built-in browser forces bare localhost to http://
# Unit coverage already lives in src/shared/browser-url.test.ts.
#
# Re-run:
#   bash docs/bug-reproductions/scripts/repro-8454-localhost-http.sh
#   # or directly:
#   npx vitest run src/shared/browser-url.test.ts -t "normalizes manual local-dev"

set -euo pipefail
cd "$(cd "$(dirname "$0")/../../.." && pwd)"
npx vitest run src/shared/browser-url.test.ts -t "normalizes manual local-dev"
