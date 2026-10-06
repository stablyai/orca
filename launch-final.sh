#!/bin/zsh
set -euo pipefail
QA_ROOT=/Users/m4air/orca-qa/pr-25658/remote
WORKTREE=/Users/m4air/orca/workspaces/orca/pr25658-review-qa-2
PORT=9441
mkdir -p "$QA_ROOT/home" "$QA_ROOT/user-data" "$QA_ROOT/codex-home" "$QA_ROOT/claude-config" "$QA_ROOT/mock-keychain"
exec env -i PATH="$PATH" HOME="$QA_ROOT/home" CODEX_HOME="$QA_ROOT/codex-home" CLAUDE_CONFIG_DIR="$QA_ROOT/claude-config" ORCA_DEV_USER_DATA_PATH="$QA_ROOT/user-data" ORCA_BACKGROUND_LAUNCH=1 REMOTE_DEBUGGING_PORT="$PORT" node "$WORKTREE/config/scripts/run-electron-vite-dev.mjs" -- --password-store=basic --use-mock-keychain
