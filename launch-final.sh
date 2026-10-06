#!/bin/bash
# Isolated, hidden Electron launch for the final PR 25658 head.
set -eu
ROOT='/Users/m4air/orca/workspaces/orca/pr25658-review-qa'
BASE='/Users/m4air/orca-qa/pr-25658/remote'
RIG="$BASE/rig/final"
NODE='/opt/homebrew/opt/node@24/bin/node'
RENDERER_PORT=5176
CDP_PORT=9603
mkdir -p "$RIG/home/.codex" "$RIG/home/.claude" "$RIG/userData" "$RIG/tmp" "$RIG/logs"
touch "$RIG/home/.gitconfig"
shasum -a 256 /Users/m4air/.codex/hooks.json /Users/m4air/.codex/config.toml > "$RIG/codex-hashes-before.txt"
SHA="$(git -C "$ROOT" rev-parse HEAD)"
printf '%s\n' "$SHA" > "$RIG/launched-sha.txt"
env -i \
  HOME="$RIG/home" USER='m4air' LOGNAME='m4air' SHELL='/bin/zsh' \
  PATH='/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' \
  TMPDIR="$RIG/tmp" LANG='en_US.UTF-8' LC_ALL='en_US.UTF-8' \
  GIT_CONFIG_GLOBAL="$RIG/home/.gitconfig" GIT_CONFIG_NOSYSTEM=1 \
  ORCA_DEV_USER_DATA_PATH="$RIG/userData" ORCA_BACKGROUND_LAUNCH=1 ORCA_DISABLE_MACOS_LOGIN_SHELL=1 \
  CODEX_HOME="$RIG/home/.codex" ORCA_CODEX_HOME="$RIG/home/.codex" CLAUDE_CONFIG_DIR="$RIG/home/.claude" \
  REMOTE_DEBUGGING_PORT="$CDP_PORT" VITE_EXPOSE_STORE=true \
  "$NODE" "$ROOT/config/scripts/run-electron-vite-dev.mjs" -c "$RIG/vite.config.mjs" -- \
    --password-store=basic --use-mock-keychain --remote-allow-origins='*' > "$RIG/logs/launch.log" 2>&1 &
RUNNER=$!
printf '%s\n' "$RUNNER" > "$RIG/runner.pid"
for _i in $(seq 1 180); do
  if curl -sf "http://127.0.0.1:${CDP_PORT}/json" 2>/dev/null | grep -q "127.0.0.1:${RENDERER_PORT}"; then
    printf '%s\n' "$CDP_PORT" > "$RIG/cdp.port"
    printf '%s\n' "$RENDERER_PORT" > "$RIG/renderer.port"
    wait "$RUNNER"
    exit 0
  fi
  if ! kill -0 "$RUNNER" 2>/dev/null; then
    tail -80 "$RIG/logs/launch.log" >&2
    exit 1
  fi
  sleep 2
done
tail -80 "$RIG/logs/launch.log" >&2
exit 1
