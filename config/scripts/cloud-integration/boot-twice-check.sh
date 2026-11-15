#!/usr/bin/env bash
# Premerge step for image changes (premerge-check.sh runs it only when cloud/apps/sandbox-control/image/** changed):
# provisions the golden image in Docker and boots it twice; the second boot must install, fetch and redo nothing.
# See cloud/apps/sandbox-control/image/boot-twice/README.md. Run from the merged worktree's root.
#   - Docker unavailable: a loud warning and exit 0 (fail open), so a host without Docker never blocks every merge.
#   - On omarchy it takes its own slot (~/orca-offload/bin/slot.sh), waiting at most BOOT_TWICE_SLOT_WAIT_S (300 s).
#   - Hard limit BOOT_TWICE_TIMEOUT_S (600 s); a cold image build is ~5 min, a cached one ~15 s.
set -uo pipefail
timeout_s=${BOOT_TWICE_TIMEOUT_S:-600}
slot_wait_s=${BOOT_TWICE_SLOT_WAIT_S:-300}
if ! docker info >/dev/null 2>&1; then
  printf '\npremerge: WARNING ==============================================================\n' >&2
  printf 'premerge: WARNING: Docker is unavailable here, so the boot-twice image check DID NOT RUN.\n' >&2
  printf 'premerge: WARNING: run it by hand before merging this image change (see image/boot-twice/README.md).\n' >&2
  printf 'premerge: WARNING ==============================================================\n\n' >&2
  exit 0
fi
slot_tool="$HOME/orca-offload/bin/slot.sh"
tag="boot-twice-$$-$(date +%s)"
if [[ -x "$slot_tool" ]]; then
  waited=0
  until "$slot_tool" acquire "$tag" >/dev/null 2>&1; do
    if ((waited >= slot_wait_s)); then
      echo "premerge: FAILED: boot-twice image check found no free omarchy slot in ${slot_wait_s}s; rerun the premerge" >&2
      exit 1
    fi
    sleep 15
    waited=$((waited + 15))
  done
  trap '"$slot_tool" release "$tag" >/dev/null 2>&1 || rm -rf "$HOME/orca-offload/wt/$tag"' EXIT
fi
echo "premerge: boot-twice image check (limit ${timeout_s}s)"
report="$(mktemp)"
(cd cloud && pnpm install --frozen-lockfile >/dev/null)
timeout --kill-after=30 "$timeout_s" pnpm --dir cloud --filter @orca-cloud/sandbox-control exec \
  tsx image/boot-twice/boot-twice.ts --release latest --report "$report" >/dev/null
status=$?
if ((status == 124 || status == 137)); then
  echo "premerge: FAILED: boot-twice image check passed its ${timeout_s}s limit (cold image build? rerun once)" >&2
elif ((status != 0)); then
  echo "premerge: FAILED: boot-twice image check: the second boot of the image is not clean:" >&2
  jq -r '.failures[]? | "premerge:   " + .' "$report" >&2 2>/dev/null || true
  echo "premerge: details: cloud/apps/sandbox-control/image/boot-twice/README.md" >&2
else
  echo "premerge: boot-twice image check OK ($(jq -r '"boot 2 " + (.boots[1].ms|tostring) + " ms"' "$report" 2>/dev/null))"
fi
rm -f "$report"
exit "$status"
