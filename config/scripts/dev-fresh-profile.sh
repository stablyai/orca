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
if [[ "${1:-}" == "--keep" ]]; then
  KEEP=1
fi

PROFILE_DIR="${ORCA_FRESH_PROFILE_DIR:-$(mktemp -d -t orca-fresh-profile)}"
mkdir -p "$PROFILE_DIR"

cleanup() {
  if [[ "$KEEP" -eq 0 && -z "${ORCA_FRESH_PROFILE_DIR:-}" ]]; then
    rm -rf "$PROFILE_DIR"
    echo "[dev-fresh-profile] removed $PROFILE_DIR"
  else
    echo "[dev-fresh-profile] kept $PROFILE_DIR"
  fi
}
trap cleanup EXIT

echo "[dev-fresh-profile] using userData=$PROFILE_DIR"
ORCA_DEV_USER_DATA_PATH="$PROFILE_DIR" exec pnpm dev
