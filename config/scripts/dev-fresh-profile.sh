#!/usr/bin/env bash
# Launch `pn dev` with a fresh, isolated userData profile so the app behaves
# like a first-time install (onboarding overlay paints, no persisted repos,
# no saved sessions). Your real `orca-dev` profile is left untouched.
#
# Usage:
#   ./config/scripts/dev-fresh-profile.sh           # ephemeral temp profile, deleted on exit
#   ./config/scripts/dev-fresh-profile.sh --keep    # keep the profile dir after exit
#   ORCA_FRESH_PROFILE_DIR=/some/path ./config/scripts/dev-fresh-profile.sh   # use a fixed dir
set -euo pipefail

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--keep] [--help]" >&2
      exit 2 ;;
  esac
done

PROFILE_DIR="${ORCA_FRESH_PROFILE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/orca-fresh-profile.XXXXXXXX")}"
mkdir -p "$PROFILE_DIR"

cleanup() {
  if [[ "$KEEP" -eq 0 && -z "${ORCA_FRESH_PROFILE_DIR:-}" ]]; then
    # Guard rm -rf against accidental empty/unrelated PROFILE_DIR.
    [[ -n "${PROFILE_DIR:-}" && -d "$PROFILE_DIR" && "$PROFILE_DIR" == */orca-fresh-profile* ]] || return 0
    rm -rf "$PROFILE_DIR"
    echo "[dev-fresh-profile] removed $PROFILE_DIR"
  else
    echo "[dev-fresh-profile] kept $PROFILE_DIR"
  fi
}
trap cleanup EXIT

echo "[dev-fresh-profile] using userData=$PROFILE_DIR"
# Don't exec — we need the EXIT trap to fire so the temp profile gets cleaned up.
ORCA_DEV_USER_DATA_PATH="$PROFILE_DIR" pnpm dev
