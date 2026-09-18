#!/usr/bin/env bash
set -euo pipefail
umask 077
[ ! -e /vercel/project ] || { echo 'Project already exists; refusing to replace it' >&2; exit 1; }
export GIT_TERMINAL_PROMPT=0
git init -b main /vercel/project
git -C /vercel/project remote add origin "$ORCA_REPO_URL"
git -C /vercel/project fetch --depth 1 origin "$ORCA_REPO_REF"
git -C /vercel/project checkout -B main FETCH_HEAD
[ "$(git -C /vercel/project rev-parse HEAD)" = "$ORCA_REPO_REF" ]
mkdir -p /vercel/orca-control
printf '%s' "$ORCA_WORKSPACE_OWNER" >/vercel/orca-control/owner
